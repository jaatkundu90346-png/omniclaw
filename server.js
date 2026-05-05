import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { OmniClawAgent } from "./src/core/agent.js";
import { attachWsGateway } from "./src/core/ws-gateway.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeDir = process.pkg ? process.cwd() : __dirname;
const publicDir = path.join(runtimeDir, "public");

const agent = new OmniClawAgent({
  rootDir: runtimeDir,
});
const eventClients = new Set();

const port = Number(process.env.PORT || 3147);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function broadcastEvent(record) {
  const chunk = `data: ${JSON.stringify(record)}\n\n`;
  for (const client of eventClients) {
    client.write(chunk);
  }
}

agent.gateway.onEvent(broadcastEvent);

function startCodexLoginWindow() {
  const config = agent.config.getConfig();
  const command = String(config.provider?.codexCommand || "codex").trim() || "codex";
  if (process.platform === "win32") {
    const loginCommand = [
      "$ErrorActionPreference = 'Continue'",
      `$codexCommand = '${command.replace(/'/g, "''")}'`,
      "Write-Host 'Checking Codex CLI...'",
      "try { & $codexCommand --version; $ok = $LASTEXITCODE -eq 0 } catch { $ok = $false; Write-Host $_.Exception.Message }",
      "if (-not $ok) { Write-Host 'Installing official @openai/codex CLI with npm...'; npm.cmd install -g @openai/codex }",
      "Write-Host 'Starting Codex login. Choose Sign in with ChatGPT.'",
      "& $codexCommand login",
    ].join("; ");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Start-Process",
        "powershell.exe",
        "-ArgumentList",
        `'-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-Command','${loginCommand.replace(/'/g, "''")}'`,
      ],
      { cwd: runtimeDir, detached: true, windowsHide: true, stdio: "ignore" },
    );
    child.unref();
    return { started: true, platform: process.platform, command: `${command} login`, setup: "installs @openai/codex first if the current command cannot run" };
  }
  const child = spawn(command, ["login"], { cwd: runtimeDir, detached: true, stdio: "ignore" });
  child.unref();
  return { started: true, platform: process.platform, command: `${command} login` };
}

function sendFile(res, filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml; charset=utf-8",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
    };
    const contentType = contentTypes[ext] || "application/octet-stream";

    const body = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch (error) {
    sendJson(res, 404, { error: "Not found" });
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function getConnectorToken(req, body, url) {
  const bearer = String(req.headers.authorization || "").trim();
  const bearerToken = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "";
  return String(
    body.connectorToken ||
      body.token ||
      url.searchParams.get("token") ||
      req.headers["x-omniclaw-token"] ||
      req.headers["x-connector-token"] ||
      bearerToken ||
      "",
  ).trim();
}

function adapterHistoryOptions(url, limitParam = "adapterLimit", statusParam = "adapterStatus") {
  return {
    limit: Number(url.searchParams.get(limitParam) || 20),
    adapterId: url.searchParams.get("adapterId") || "",
    status: url.searchParams.get(statusParam) || "",
    query: url.searchParams.get("adapterQuery") || url.searchParams.get("query") || "",
  };
}

async function retryAdapterOutbox(outboxId) {
  const item = agent.connectors.getAdapterOutboxItem(outboxId);
  if (item.adapterId === "telegram") {
    return agent.telegramWorker.retryOutbox(item.id);
  }
  if (item.adapterId === "discord") {
    return agent.discordWorker.retryOutbox(item.id);
  }
  throw new Error(`Adapter ${item.adapterId || "(missing)"} does not support retry yet.`);
}

async function cacheAdapterAttachment(input = {}) {
  const { delivery } = agent.connectors.getAdapterDeliveryAttachment(input);
  if (delivery.adapterId === "telegram") {
    return agent.telegramWorker.cacheAttachment(input);
  }
  if (delivery.adapterId === "discord") {
    return agent.discordWorker.cacheAttachment(input);
  }
  throw new Error(`Adapter ${delivery.adapterId || "(missing)"} does not support attachment caching yet.`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      name: "OmniClaw",
      provider: agent.getProviderInfo(),
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, agent.getState());
    return;
  }

  if (req.method === "GET" && pathname === "/api/agents") {
    sendJson(res, 200, {
      agents: agent.getState().agents,
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/agents/")) {
    const agentId = pathname.slice("/api/agents/".length);
    const item = agent.getState().agents.find((entry) => entry.id === agentId) || null;
    if (!item) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }
    sendJson(res, 200, { agent: item });
    return;
  }

  if (req.method === "GET" && pathname === "/api/gateway") {
    sendJson(res, 200, {
      overview: agent.gateway.getOverview(),
      events: agent.gateway.listEvents(50),
      runs: agent.gateway.listRuns(20),
      approvals: agent.gateway.listApprovals(),
      delegations: agent.gateway.listDelegations({ limit: 20 }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/layers") {
    sendJson(res, 200, agent.getOpenClawLayerReport());
    return;
  }

  if (req.method === "GET" && pathname === "/api/delegations") {
    sendJson(res, 200, {
      delegations: agent.gateway.listDelegations({
        limit: Number(url.searchParams.get("limit") || 50),
        status: url.searchParams.get("status") || "",
        agentId: url.searchParams.get("agentId") || "",
      }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/delegations/create") {
    try {
      const body = await parseBody(req);
      const result = agent.queueDelegation({
        sourceAgentId: body.sourceAgentId || body.sourceAgent || "main",
        targetAgentId: body.targetAgentId || body.agentId,
        instruction: body.instruction || body.task,
        parentSessionId: body.parentSessionId || body.sessionId || "",
        parentRunId: body.parentRunId || "",
        source: body.source || "manual-dashboard",
      });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/delegations/cancel") {
    try {
      const body = await parseBody(req);
      const result = agent.cancelDelegation(body.delegationId || body.id, body.note || "api-cancel");
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/delegations/retry") {
    try {
      const body = await parseBody(req);
      const result = agent.retryDelegation(body.delegationId || body.id, {
        sourceAgentId: body.sourceAgentId || "",
        targetAgentId: body.targetAgentId || "",
        instruction: body.instruction || "",
        parentSessionId: body.parentSessionId || "",
        parentRunId: body.parentRunId || "",
        source: body.source || "api-retry",
      });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "hello", at: new Date().toISOString() })}\n\n`);
    eventClients.add(res);
    req.on("close", () => {
      eventClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, {
      sessions: agent.sessions.listSessions(Number(url.searchParams.get("limit") || 50)),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors") {
    sendJson(res, 200, {
      config: agent.connectors.getPublicConfig(),
      adaptersOverview: agent.connectors.getAdaptersOverview(),
      adapters: agent.connectors.listAdapters(),
      telegramWorker: agent.telegramWorker.getStatus(),
      discordWorker: agent.discordWorker.getStatus(),
      adapterDeliveries: agent.connectors.listAdapterDeliveries(adapterHistoryOptions(url)),
      adapterOutbox: agent.connectors.listAdapterOutbox(adapterHistoryOptions(url, "outboxLimit", "outboxStatus")),
      adapterAttachmentCache: agent.connectors.listAdapterAttachmentCache(adapterHistoryOptions(url, "cacheLimit", "cacheStatus")),
      adapterAttachmentExtracts: agent.connectors.listAdapterAttachmentExtracts(adapterHistoryOptions(url, "extractLimit", "extractStatus")),
      adapterAttachmentInjections: agent.connectors.listAdapterAttachmentInjections(adapterHistoryOptions(url, "injectLimit", "injectStatus")),
      adapterAttachmentAnalyses: agent.connectors.listAdapterAttachmentAnalyses(adapterHistoryOptions(url, "analysisLimit", "analysisStatus")),
      attachmentCleanupRuns: agent.connectors.listAttachmentCleanupRuns(Number(url.searchParams.get("cleanupLimit") || 10)),
      overview: agent.connectors.getOverview(),
      webhookDeliveries: agent.connectors.listWebhookDeliveries(Number(url.searchParams.get("limit") || 20)),
      fileDropRecords: agent.connectors.listFileDropRecords(Number(url.searchParams.get("limit") || 20)),
      pendingFiles: agent.connectors.listPendingFiles({
        limit: Number(url.searchParams.get("pendingLimit") || 20),
        agentId: url.searchParams.get("agentId") || "",
      }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/adapters") {
    sendJson(res, 200, {
      overview: agent.connectors.getAdaptersOverview(),
      adapters: agent.connectors.listAdapters(),
      telegramWorker: agent.telegramWorker.getStatus(),
      discordWorker: agent.discordWorker.getStatus(),
      adapterDeliveries: agent.connectors.listAdapterDeliveries(adapterHistoryOptions(url)),
      adapterOutbox: agent.connectors.listAdapterOutbox(adapterHistoryOptions(url, "outboxLimit", "outboxStatus")),
      adapterAttachmentCache: agent.connectors.listAdapterAttachmentCache(adapterHistoryOptions(url, "cacheLimit", "cacheStatus")),
      adapterAttachmentExtracts: agent.connectors.listAdapterAttachmentExtracts(adapterHistoryOptions(url, "extractLimit", "extractStatus")),
      adapterAttachmentInjections: agent.connectors.listAdapterAttachmentInjections(adapterHistoryOptions(url, "injectLimit", "injectStatus")),
      adapterAttachmentAnalyses: agent.connectors.listAdapterAttachmentAnalyses(adapterHistoryOptions(url, "analysisLimit", "analysisStatus")),
      attachmentCleanupRuns: agent.connectors.listAttachmentCleanupRuns(Number(url.searchParams.get("cleanupLimit") || 10)),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/config") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.setAdapterConfig(body);
      agent.gateway.addEvent("connector.adapter_config_updated", {
        adapterId: result.adapter.id,
        enabled: result.adapter.enabled,
        status: result.adapter.status,
        defaultAgentId: result.adapter.defaultAgentId,
        secretUpdated: result.secretUpdated,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/test") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.testAdapter(body.adapterId || body.id);
      agent.gateway.addEvent("connector.adapter_tested", {
        adapterId: result.adapterId,
        ok: result.ok,
        status: result.status,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/retry") {
    try {
      const body = await parseBody(req);
      const result = await retryAdapterOutbox(body.outboxId || body.id);
      agent.gateway.addEvent("connector.adapter_outbox_retried", {
        outboxId: result.outbox?.id || body.outboxId || "",
        adapterId: result.outbox?.adapterId || "",
        status: result.outbox?.status || "",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message, outbox: error.outbox || null });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/cache") {
    try {
      const body = await parseBody(req);
      const result = await cacheAdapterAttachment({
        deliveryId: body.deliveryId || body.id,
        attachmentIndex: Number(body.attachmentIndex || 0),
        attachmentId: body.attachmentId || "",
        maxBytes: Number(body.maxBytes || 5_000_000),
      });
      agent.gateway.addEvent("connector.adapter_attachment_cache_requested", {
        deliveryId: result.cache?.deliveryId || body.deliveryId || "",
        cacheId: result.cache?.id || "",
        adapterId: result.cache?.adapterId || "",
        status: result.cache?.status || "",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message, cache: error.cache || null, delivery: error.delivery || null });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/extract") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.extractAdapterAttachmentCache({
        cacheId: body.cacheId || body.id,
        deliveryId: body.deliveryId || "",
        attachmentIndex: Number(body.attachmentIndex || 0),
        maxBytes: Number(body.maxBytes || 1_000_000),
        maxChars: Number(body.maxChars || 12000),
      });
      agent.gateway.addEvent("connector.adapter_attachment_extracted", {
        extractId: result.extract?.id || "",
        cacheId: result.extract?.cacheId || body.cacheId || "",
        deliveryId: result.extract?.deliveryId || "",
        adapterId: result.extract?.adapterId || "",
        status: result.extract?.status || "",
        characterCount: result.extract?.characterCount || 0,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/inject") {
    try {
      const body = await parseBody(req);
      const result = await agent.injectAdapterAttachmentExtract({
        extractId: body.extractId || body.id,
        agentId: body.agentId || "",
        sessionId: body.sessionId || "",
        label: body.label || "",
        maxChars: Number(body.maxChars || 12000),
        source: "api",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message,
        injection: error.injection || null,
        extract: error.extract || null,
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/analyze") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.analyzeAdapterAttachmentMedia({
        extractId: body.extractId || body.id || "",
        cacheId: body.cacheId || "",
        deliveryId: body.deliveryId || "",
        attachmentIndex: Number(body.attachmentIndex || 0),
        force: body.force === true,
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      agent.gateway.addEvent("connector.adapter_attachment_media_analyzed", {
        analysisId: result.analysis?.id || "",
        extractId: result.analysis?.extractId || "",
        adapterId: result.analysis?.adapterId || "",
        provider: result.analysis?.provider || "",
        status: result.analysis?.status || "",
        characterCount: result.analysis?.characterCount || 0,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/analyze-pending") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.analyzePendingMediaAttachments({
        limit: Number(body.limit || 5),
        force: body.force === true,
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      agent.gateway.addEvent("connector.adapter_attachment_media_batch_analyzed", {
        scanned: result.scanned,
        completed: result.completed,
        failed: result.failed,
        skipped: result.skipped,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/media-provider/test") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.testAttachmentMediaAnalysisProvider({
        mediaKind: body.mediaKind || "",
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
        testArgs: "testArgs" in body ? body.testArgs : undefined,
      });
      agent.gateway.addEvent("connector.media_provider_tested", {
        provider: result.provider,
        mediaKind: result.mediaKind,
        routeApplied: result.routeApplied,
        status: result.status,
        ok: result.ok,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/adapters/attachments/media-provider/setup") {
    try {
      const result = await agent.connectors.getLocalMediaProviderSetup();
      agent.gateway.addEvent("connector.media_provider_setup_checked", {
        readyCount: result.readyCount,
        missingCount: result.missingCount,
        warnings: result.warnings.length,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/media-provider/install-plan") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.createLocalMediaProviderInstallPlan({
        engineIds: Array.isArray(body.engineIds) ? body.engineIds : [],
        includeAvailable: body.includeAvailable === true,
        platform: body.platform || "",
      });
      agent.gateway.addEvent("connector.media_provider_install_plan_created", {
        targetCount: result.targetCount,
        commandCount: result.commandCount,
        platform: result.platform,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/ingest") {
    try {
      const body = await parseBody(req);
      const deliveryId = String(body.deliveryId || body.id || "").trim();
      if (!deliveryId) {
        throw new Error("deliveryId is required");
      }
      const delivery = agent.connectors.getAdapterDelivery(deliveryId);
      const result = await agent.ingestAdapterDeliveryAttachments(delivery, {
        force: body.force === true,
        source: "api",
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/cleanup") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.cleanupAdapterAttachmentCache({
        dryRun: body.dryRun !== false,
        force: body.force === true,
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      agent.gateway.addEvent("connector.adapter_attachment_cleanup_completed", {
        status: result.status,
        dryRun: result.dryRun,
        candidates: result.candidates,
        purged: result.purged,
        orphanPurged: result.orphanPurged,
        bytesFreed: result.bytesFreed,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/telegram/status") {
    sendJson(res, 200, {
      telegramWorker: agent.telegramWorker.getStatus(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/discord/status") {
    sendJson(res, 200, {
      discordWorker: agent.discordWorker.getStatus(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/discord/start") {
    try {
      const body = await parseBody(req);
      const discordWorker = agent.discordWorker.start({
        connectNow: body.connectNow !== false,
      });
      sendJson(res, 200, { discordWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/discord/stop") {
    try {
      const body = await parseBody(req);
      const discordWorker = agent.discordWorker.stop(body.reason || "api-stop");
      sendJson(res, 200, { discordWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/discord/dispatch") {
    try {
      const body = await parseBody(req);
      const result = await agent.discordWorker.dispatch({
        mockEvents: Array.isArray(body.mockEvents) ? body.mockEvents : undefined,
        event: body.event,
        payload: body.payload,
        reply: Boolean(body.reply),
        source: body.source || "api",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/telegram/start") {
    try {
      const body = await parseBody(req);
      const telegramWorker = agent.telegramWorker.start({
        intervalMs: Number(body.intervalMs || 5000),
        limit: Number(body.limit || 10),
        runNow: body.runNow !== false,
      });
      sendJson(res, 200, { telegramWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/telegram/stop") {
    try {
      const body = await parseBody(req);
      const telegramWorker = agent.telegramWorker.stop(body.reason || "api-stop");
      sendJson(res, 200, { telegramWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/telegram/poll") {
    try {
      const body = await parseBody(req);
      const result = await agent.telegramWorker.pollOnce({
        limit: Number(body.limit || 10),
        timeoutSeconds: Number(body.timeoutSeconds || 1),
        offset: body.offset,
        mockUpdates: Array.isArray(body.mockUpdates) ? body.mockUpdates : undefined,
        reply: body.reply !== false,
        source: body.source || "api",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message, adapter: error.adapter || null });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/webhook") {
    try {
      const body = await parseBody(req);
      const result = await agent.receiveWebhook({
        ...body,
        connectorToken: getConnectorToken(req, body, url),
        source: body.source || "http",
      });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, code: error.code || "webhook_failed" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/config") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.updateConfig({
        webhook: body.webhook || {},
        fileDrop: body.fileDrop || {},
        attachmentIngestion: body.attachmentIngestion || {},
        attachmentRetention: body.attachmentRetention || {},
        attachmentMediaAnalysis: body.attachmentMediaAnalysis || {},
      });
      agent.gateway.addEvent("connector.config_updated", {
        webhookEnabled: result.config.webhook.enabled,
        webhookDefaultAgentId: result.config.webhook.defaultAgentId,
        webhookAllowPayloadAgent: result.config.webhook.allowPayloadAgent,
        webhookRequireToken: result.config.webhook.requireToken,
        fileDropEnabled: result.config.fileDrop.enabled,
        fileDropDefaultAgentId: result.config.fileDrop.defaultAgentId,
        fileDropArchiveProcessed: result.config.fileDrop.archiveProcessed,
        attachmentIngestionEnabled: result.config.attachmentIngestion.enabled,
        attachmentAutoInject: result.config.attachmentIngestion.autoInject,
        attachmentRetentionEnabled: result.config.attachmentRetention.enabled,
        attachmentRetentionMaxBytes: result.config.attachmentRetention.maxTotalBytes,
        attachmentMediaAnalysisEnabled: result.config.attachmentMediaAnalysis.enabled,
        attachmentMediaAnalysisProvider: result.config.attachmentMediaAnalysis.provider,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/webhook/token/rotate") {
    try {
      const result = agent.connectors.rotateWebhookToken();
      agent.gateway.addEvent("connector.webhook_token_rotated", {
        tokenPreview: result.config.webhook.tokenPreview,
        tokenRotatedAt: result.config.webhook.tokenRotatedAt,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/file-drop/scan") {
    try {
      const body = await parseBody(req);
      const result = await agent.scanFileDrop({
        agentId: body.agentId || "",
        limit: Number(body.limit || 10),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, code: error.code || "file_drop_failed" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/memory") {
    const agentId = String(url.searchParams.get("agentId") || "").trim();
    sendJson(res, 200, {
      overview: agent.memory.getOverview(agentId),
      longTerm: agent.memory.getLongTermMemory(Number(url.searchParams.get("limit") || 50), agentId),
      dreams: agent.memory.getDreams(Number(url.searchParams.get("dreamLimit") || 20), agentId),
      candidates: agent.memory.getPromotionCandidates({
        agentId,
        limit: Number(url.searchParams.get("candidateLimit") || 12),
      }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/memory/insights") {
    const agentId = String(url.searchParams.get("agentId") || "").trim();
    const dreams = agent.memory.getDreams(10, agentId);
    const insight = dreams.length > 0 ? dreams[0] : null;
    sendJson(res, 200, { insight });
    return;
  }

  if (req.method === "POST" && pathname === "/api/memory/promote") {
    try {
      const body = await parseBody(req);
      const result = agent.memory.promoteMemory(body);
      agent.gateway.addEvent("memory.promoted", {
        memoryId: result.memory.id,
        created: result.created,
        sourceRef: result.memory.sourceRef,
        agentId: result.memory.agentId,
      });
      sendJson(res, result.created ? 201 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/memory/dream") {
    try {
      const body = await parseBody(req);
      const result = await agent.memory.runDreamSweep({
        agentId: body.agentId || "main",
        limit: Number(body.limit || 5),
        minScore: Number(body.minScore || 0.65),
        source: "api",
        provider: agent.provider,
      });
      agent.gateway.addEvent("memory.dream_completed", {
        dreamId: result.dream.id,
        promotedCount: result.promoted.length,
        agentId: result.dream.agentId,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/sessions/") && pathname.endsWith("/summary")) {
    const sessionId = pathname.slice("/api/sessions/".length, -"/summary".length);
    const summary = agent.summarizer.readSummary(sessionId);
    if (!summary) {
      sendJson(res, 404, { error: "Summary not found for session" });
      return;
    }
    sendJson(res, 200, { summary });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/sessions/")) {
    const sessionId = pathname.slice("/api/sessions/".length);
    const session = agent.sessions.getSession(sessionId, {
      messageLimit: Number(url.searchParams.get("messageLimit") || 80),
    });
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, { session });
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions/reset") {
    try {
      const body = await parseBody(req);
      const sessionId = String(body.sessionId || "").trim();
      const reason = String(body.reason || "manual-reset").trim();
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      const session = agent.sessions.archiveSession(sessionId, reason);
      agent.gateway.addEvent("session.reset", {
        sessionId,
        reason,
      });
      sendJson(res, 200, { session });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/system/status") {
    try {
      const summary = await agent.systemMonitor.getSystemSummary();
      const processes = await agent.systemMonitor.listProcesses();
      sendJson(res, 200, { summary, processes });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/approvals") {
    sendJson(res, 200, {
      approvals: agent.gateway.listApprovals(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/shell/audit") {
    sendJson(res, 200, {
      overview: agent.shellAudit.getOverview(),
      policy: agent.shellExecutor.getPolicy(),
      records: agent.shellAudit.list({
        limit: Number(url.searchParams.get("limit") || 50),
        status: url.searchParams.get("status") || "",
        risk: url.searchParams.get("risk") || "",
        query: url.searchParams.get("query") || "",
      }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/shell/policy") {
    try {
      const body = await parseBody(req);
      const result = agent.customizationEngine.updateShellPolicy(body);
      agent.gateway.addEvent("shell.policy_updated", {
        allowlistMode: result.config.tools?.shellExecution?.allowlistMode,
        trustLevel: result.config.tools?.shellExecution?.trustLevel,
        timeoutMs: result.config.tools?.shellExecution?.timeoutMs,
        maxOutputBytes: result.config.tools?.shellExecution?.maxOutputBytes,
      });
      sendJson(res, 200, {
        ...result,
        policy: agent.shellExecutor.getPolicy(),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/approvals/resolve") {
    try {
      const body = await parseBody(req);
      const approvalId = String(body.approvalId || "").trim();
      const decision = String(body.decision || "").trim();
      const note = String(body.note || "").trim();

      if (!approvalId || !decision) {
        sendJson(res, 400, { error: "approvalId and decision are required" });
        return;
      }

      const result = await agent.resolveApproval(approvalId, decision, note);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/trust") {
    sendJson(res, 200, {
      overview: agent.trust.getOverview(),
      devices: agent.trust.listDevices(),
      pairingRequests: agent.trust.listPairingRequests(),
      audit: agent.trust.listAudit(Number(url.searchParams.get("limit") || 40)),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/overview") {
    sendJson(res, 200, {
      overview: agent.trust.getOverview(),
      devices: agent.trust.listDevices(),
      pairingRequests: agent.trust.listPairingRequests(),
      audit: agent.trust.listAudit(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/pairing/request") {
    try {
      const body = await parseBody(req);
      const result = agent.trust.requestPairing({
        label: body.label,
        role: body.role,
        fingerprint: body.fingerprint,
        remoteAddress: req.socket.remoteAddress || "",
      });
      agent.gateway.addEvent(result.tokenRequired ? "trust.device_token_required" : "trust.pairing_requested", {
        requestId: result.request?.id || "",
        deviceId: result.device?.id || "",
        role: result.request?.role || result.device?.role || body.role || "operator",
        fingerprint: result.request?.fingerprint || result.device?.fingerprint || "",
      });
      sendJson(res, result.request ? 202 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/pairing/request") {
    try {
      const body = await parseBody(req);
      const result = agent.trust.requestPairing({
        label: body.label,
        role: body.role,
        fingerprint: body.fingerprint,
        remoteAddress: req.socket.remoteAddress || "",
      });
      agent.gateway.addEvent(result.tokenRequired ? "trust.device_token_required" : "trust.pairing_requested", {
        requestId: result.request?.id || "",
        deviceId: result.device?.id || "",
        role: result.request?.role || result.device?.role || body.role || "operator",
        fingerprint: result.request?.fingerprint || result.device?.fingerprint || "",
      });
      sendJson(res, result.request ? 202 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/pairing/approve") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const result = agent.trust.approvePairing(requestId, String(body.note || "dashboard-approval").trim());
      agent.gateway.addEvent("trust.pairing_approved", {
        requestId,
        deviceId: result.device.id,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/pairing/approve") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const result = agent.trust.approvePairing(requestId, String(body.note || "auth-approval").trim());
      agent.gateway.addEvent("trust.pairing_approved", {
        requestId,
        deviceId: result.device.id,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/pairing/reject") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const request = agent.trust.rejectPairing(requestId, String(body.note || "dashboard-rejection").trim());
      agent.gateway.addEvent("trust.pairing_rejected", {
        requestId,
        role: request.role,
      });
      sendJson(res, 200, { request });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/pairing/reject") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const request = agent.trust.rejectPairing(requestId, String(body.note || "auth-rejection").trim());
      agent.gateway.addEvent("trust.pairing_rejected", {
        requestId,
        role: request.role,
      });
      sendJson(res, 200, { request });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/devices/revoke") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const device = agent.trust.revokeDevice(deviceId, String(body.note || "dashboard-revoke").trim());
      agent.gateway.addEvent("trust.device_revoked", {
        deviceId,
        role: device.role,
      });
      sendJson(res, 200, { device });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/device/revoke") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const device = agent.trust.revokeDevice(deviceId, String(body.note || "auth-device-revoke").trim());
      agent.gateway.addEvent("trust.device_revoked", {
        deviceId,
        role: device.role,
      });
      sendJson(res, 200, { device });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/devices/rotate-token") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const result = agent.trust.rotateDeviceToken(deviceId, String(body.note || "dashboard-token-rotation").trim());
      agent.gateway.addEvent("trust.device_token_rotated", {
        deviceId,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/device-token/rotate") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const result = agent.trust.rotateDeviceToken(deviceId, String(body.note || "auth-token-rotation").trim());
      agent.gateway.addEvent("trust.device_token_rotated", {
        deviceId,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/gateway/rotate") {
    try {
      const result = agent.trust.rotateGatewayToken();
      agent.gateway.addEvent("trust.gateway_token_rotated", {
        rotatedAt: result.status.rotatedAt,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/gateway-token/rotate") {
    try {
      const result = agent.trust.rotateGatewayToken();
      agent.gateway.addEvent("trust.gateway_token_rotated", {
        rotatedAt: result.status.rotatedAt,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/gateway-token/revoke") {
    try {
      const body = await parseBody(req);
      const status = agent.trust.revokeGatewayToken(String(body.note || "auth-gateway-revoke").trim());
      agent.gateway.addEvent("trust.gateway_token_revoked", {
        revokedAt: status.revokedAt,
      });
      sendJson(res, 200, { status });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/workspace") {
    sendJson(res, 200, {
      ...agent.getWorkspaceState(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/schedules") {
    sendJson(res, 200, {
      overview: agent.scheduler.getOverview(),
      schedules: agent.schedules.listSchedules(Number(url.searchParams.get("limit") || 50)),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules") {
    try {
      const body = await parseBody(req);
      const tool = String(body.tool || "").trim();
      if (!tool) {
        sendJson(res, 400, { error: "tool is required" });
        return;
      }
      const schedule = agent.scheduler.createSchedule({
        name: String(body.name || `${tool} schedule`).trim(),
        tool,
        input: body.input || {},
        agentId: body.agentId || "main",
        intervalMs: Number(body.intervalSeconds || 60) * 1000,
        maxRuns: Number(body.maxRuns || 0),
        runNow: Boolean(body.runNow),
        source: "api",
        retry: {
          maxAttempts: Number(body.retryMaxAttempts || 1),
          delayMs: Number(body.retryDelaySeconds || 5) * 1000,
        },
      });
      sendJson(res, 201, { schedule });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules/run") {
    try {
      const body = await parseBody(req);
      const scheduleId = String(body.scheduleId || "").trim();
      if (!scheduleId) {
        sendJson(res, 400, { error: "scheduleId is required" });
        return;
      }
      const result = agent.scheduler.runNow(scheduleId, "api");
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules/toggle") {
    try {
      const body = await parseBody(req);
      const scheduleId = String(body.scheduleId || "").trim();
      if (!scheduleId) {
        sendJson(res, 400, { error: "scheduleId is required" });
        return;
      }
      const schedule = agent.scheduler.setStatus(scheduleId, body.status || "paused");
      sendJson(res, 200, { schedule });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules/delete") {
    try {
      const body = await parseBody(req);
      const scheduleId = String(body.scheduleId || "").trim();
      if (!scheduleId) {
        sendJson(res, 400, { error: "scheduleId is required" });
        return;
      }
      const schedule = agent.scheduler.deleteSchedule(scheduleId);
      sendJson(res, 200, { schedule });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/plugins") {
    sendJson(res, 200, {
      plugins: agent.plugins.getAll(),
      tools: agent.plugins.getToolDefinitions(),
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/plugins/")) {
    const pluginId = pathname.slice("/api/plugins/".length);
    const plugin = agent.plugins.getDetail(pluginId);
    if (!plugin) {
      sendJson(res, 404, { error: "Plugin not found" });
      return;
    }
    sendJson(res, 200, { plugin });
    return;
  }

  if (req.method === "POST" && pathname === "/api/plugins/reload") {
    try {
      const plugins = agent.refreshPlugins("http-reload");
      sendJson(res, 200, {
        plugins,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/plugins/toggle") {
    try {
      const body = await parseBody(req);
      const pluginId = String(body.pluginId || "").trim();
      if (!pluginId) {
        sendJson(res, 400, { error: "pluginId is required" });
        return;
      }
      const plugin = agent.plugins.setEnabled(pluginId, Boolean(body.enabled));
      agent.gateway.addEvent("plugin.toggled", {
        pluginId,
        enabled: plugin.enabled,
      });
      agent.refreshPlugins("toggle");
      sendJson(res, 200, plugin);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/plugins/config") {
    try {
      const body = await parseBody(req);
      const pluginId = String(body.pluginId || "").trim();
      if (!pluginId) {
        sendJson(res, 400, { error: "pluginId is required" });
        return;
      }
      const plugin = agent.plugins.updatePluginConfig(pluginId, body.config || {});
      agent.gateway.addEvent("plugin.config_updated", { pluginId });
      agent.refreshPlugins("config-update");
      sendJson(res, 200, plugin);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    sendJson(res, 200, {
      jobs: agent.jobs.listJobs(50),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/jobs/cancel") {
    try {
      const body = await parseBody(req);
      const jobId = String(body.jobId || "").trim();
      if (!jobId) {
        sendJson(res, 400, { error: "jobId is required" });
        return;
      }
      const job = agent.worker.cancelJob(jobId, String(body.reason || "api-cancel").trim());
      sendJson(res, 200, { job });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    try {
      const body = await parseBody(req);
      const tool = String(body.tool || "").trim();
      if (!tool) {
        sendJson(res, 400, { error: "tool is required" });
        return;
      }
      const job = agent.worker.enqueueToolJob({
        tool,
        input: body.input || {},
        source: "api",
        agentId: body.agentId || "main",
        scheduleId: body.scheduleId || "",
        runAt: body.runAt || "",
        retry: {
          maxAttempts: Number(body.retryMaxAttempts || body.retry?.maxAttempts || 1),
          delayMs: Number(body.retryDelaySeconds || 5) * 1000,
        },
      });
      sendJson(res, 202, job);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/config") {
    const state = agent.getState();
    sendJson(res, 200, {
      config: state.config,
      runtime: state.runtime,
      provider: state.provider,
      providerSecrets: state.providerSecrets,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/config") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("update_runtime_settings", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/provider/status") {
    const state = agent.getState();
    let readiness = null;
    try {
      readiness = await agent.customizationEngine.testProviderProfile({ live: false });
    } catch (error) {
      readiness = { ok: false, error: error.message };
    }
    sendJson(res, 200, {
      provider: state.provider,
      providerSecrets: state.providerSecrets,
      readiness,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/design/stitch") {
    const designPath = path.join(runtimeDir, "DESIGN.md");
    const designMd = fs.existsSync(designPath) ? fs.readFileSync(designPath, "utf8") : "";
    sendJson(res, 200, {
      designMd,
      designPath: "DESIGN.md",
      stitchUrl: "https://stitch.withgoogle.com/",
      prompt:
        "Import this DESIGN.md into Stitch, generate a web app dashboard refinement, then export updated DESIGN.md or HTML/CSS back into OmniClaw.",
      updatedAt: fs.existsSync(designPath) ? fs.statSync(designPath).mtime.toISOString() : null,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/design/stitch") {
    try {
      const body = await parseBody(req);
      const designMd = String(body.designMd || "").trim();
      if (!designMd) {
        sendJson(res, 400, { error: "designMd is required" });
        return;
      }
      const designPath = path.join(runtimeDir, "DESIGN.md");
      fs.writeFileSync(designPath, `${designMd}\n`);
      agent.gateway.addEvent("design.stitch_updated", {
        designPath: "DESIGN.md",
        bytes: Buffer.byteLength(designMd, "utf8"),
      });
      sendJson(res, 200, {
        updated: true,
        designPath: "DESIGN.md",
        bytes: Buffer.byteLength(designMd, "utf8"),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/profile") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("apply_provider_profile", body);
      agent.gateway.addEvent("provider.profile_applied", { profileId: body.profileId });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/key") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("set_provider_key", body);
      agent.gateway.addEvent("provider.key_updated", {
        providerId: body.providerId || "openai-compatible",
        configured: Boolean(result.status?.configured),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/provider/key/status") {
    const providerId = String(url.searchParams.get("providerId") || "").trim();
    const statuses = providerId ? [agent.secrets.getProviderKeyStatus(providerId)] : agent.secrets.getAllStatuses();
    sendJson(res, 200, { statuses });
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/test") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("test_provider_profile", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/codex/login") {
    try {
      const result = startCodexLoginWindow();
      agent.gateway.addEvent("provider.codex_login_started", result);
      sendJson(res, 200, {
        ...result,
        message: "A Codex login terminal was opened. Choose Sign in with ChatGPT there, then return to OmniClaw and test the provider.",
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/skills") {
    sendJson(res, 200, {
      skills: agent.skills.getAll(String(url.searchParams.get("agentId") || "").trim()),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/skills") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("create_skill", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    try {
      const body = await parseBody(req);
      const message = String(body.message || "").trim();

      if (!message) {
        sendJson(res, 400, { error: "message is required" });
        return;
      }

      const result = await agent.handleMessage(message, {
        sessionId: body.sessionId,
        label: body.label,
        agentId: body.agentId,
        channel: body.channel,
      });
      const conflict = result.run?.status === "busy" || result.run?.status === "archived";
      sendJson(res, conflict ? 409 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    sendFile(res, path.join(publicDir, "index.html"));
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/")) {
    const target = path.join(publicDir, pathname);
    if (target.startsWith(publicDir) && fs.existsSync(target) && fs.statSync(target).isFile()) {
      sendFile(res, target);
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

attachWsGateway({ server, agent, pathname: "/ws" });

server.listen(port, () => {
  console.log(`OmniClaw listening on http://localhost:${port}`);
});
