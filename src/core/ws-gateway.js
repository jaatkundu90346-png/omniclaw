import crypto from "node:crypto";
import { URL } from "node:url";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CONNECT_ATTEMPT_WINDOW_MS = 60_000;
const CONNECT_ATTEMPT_LIMIT = 10;

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

const RPC_SCOPE_RULES = {
  "gateway.overview": ["operator.read", "node.read"],
  "agents.list": ["operator.read"],
  "agents.get": ["operator.read"],
  "sessions.list": ["operator.read"],
  "sessions.get": ["operator.read"],
  "sessions.reset": ["operator.write"],
  "memory.overview": ["operator.read", "node.read"],
  "memory.promote": ["operator.write"],
  "memory.dream": ["operator.write"],
  "connectors.overview": ["operator.read", "node.read"],
  "connectors.webhook": ["operator.write"],
  "connectors.updateConfig": ["operator.approvals"],
  "connectors.rotateWebhookToken": ["operator.approvals"],
  "connectors.adapters": ["operator.read", "node.read"],
  "connectors.updateAdapter": ["operator.approvals"],
  "connectors.testAdapter": ["operator.write"],
  "connectors.retryAdapterOutbox": ["operator.write"],
  "connectors.cacheAdapterAttachment": ["operator.write"],
  "connectors.extractAdapterAttachment": ["operator.write"],
  "connectors.injectAdapterAttachment": ["operator.write"],
  "connectors.analyzeAdapterAttachment": ["operator.write"],
  "connectors.analyzePendingAdapterAttachments": ["operator.write"],
  "connectors.testMediaProvider": ["operator.write"],
  "connectors.mediaProviderSetup": ["operator.read"],
  "connectors.mediaProviderInstallPlan": ["operator.read"],
  "connectors.ingestAdapterAttachments": ["operator.write"],
  "connectors.cleanupAdapterAttachments": ["operator.write"],
  "connectors.telegramStatus": ["operator.read", "node.read"],
  "connectors.telegramStart": ["operator.approvals"],
  "connectors.telegramStop": ["operator.approvals"],
  "connectors.telegramPoll": ["operator.write"],
  "connectors.discordStatus": ["operator.read", "node.read"],
  "connectors.discordStart": ["operator.approvals"],
  "connectors.discordStop": ["operator.approvals"],
  "connectors.discordDispatch": ["operator.write"],
  "connectors.scanFileDrop": ["operator.write", "node.write"],
  "agent.send": ["operator.write"],
  "delegations.list": ["operator.read", "node.read"],
  "delegations.create": ["operator.write"],
  "delegations.cancel": ["operator.write"],
  "delegations.retry": ["operator.write"],
  "approvals.list": ["operator.read"],
  "approvals.resolve": ["operator.approvals"],
  "shell.audit": ["operator.read"],
  "shell.updatePolicy": ["operator.approvals"],
  "trust.overview": ["operator.read"],
  "trust.requestPairing": ["operator.write"],
  "trust.approvePairing": ["operator.approvals"],
  "trust.rejectPairing": ["operator.approvals"],
  "trust.revokeDevice": ["operator.approvals"],
  "trust.rotateDeviceToken": ["operator.approvals"],
  "trust.rotateGatewayToken": ["operator.approvals"],
  "trust.revokeGatewayToken": ["operator.approvals"],
  "skills.list": ["operator.read"],
  "skills.create": ["operator.write"],
  "config.get": ["operator.read"],
  "config.update": ["operator.write"],
  "provider.applyProfile": ["operator.write"],
  "provider.setKey": ["operator.write"],
  "provider.keyStatus": ["operator.read"],
  "provider.test": ["operator.write"],
  "workspace.status": ["operator.read", "node.read"],
  "schedules.list": ["operator.read", "node.read"],
  "schedules.create": ["operator.write"],
  "schedules.run": ["operator.write"],
  "schedules.toggle": ["operator.write"],
  "schedules.delete": ["operator.write"],
  "plugins.list": ["operator.read"],
  "plugins.get": ["operator.read"],
  "plugins.reload": ["operator.write"],
  "plugins.toggle": ["operator.write"],
  "plugins.updateConfig": ["operator.write"],
  "jobs.list": ["operator.read", "node.read"],
  "jobs.enqueueTool": ["operator.write", "node.write"],
  "jobs.cancel": ["operator.write", "node.write"],
};

function scopesAllow(requiredScopes, connectionScopes) {
  if (!Array.isArray(requiredScopes) || requiredScopes.length === 0) {
    return true;
  }
  return requiredScopes.some((scope) => connectionScopes.includes(scope));
}

function computeAcceptValue(secWebSocketKey) {
  return crypto.createHash("sha1").update(`${secWebSocketKey}${WS_GUID}`, "binary").digest("base64");
}

function encodeFrame(opcode, payload) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const payloadLength = payloadBuffer.length;

  let headerLength = 2;
  if (payloadLength >= 126 && payloadLength < 65536) {
    headerLength += 2;
  } else if (payloadLength >= 65536) {
    headerLength += 8;
  }

  const frame = Buffer.allocUnsafe(headerLength + payloadLength);
  frame[0] = 0x80 | (opcode & 0x0f); // FIN + opcode

  let offset = 2;
  if (payloadLength < 126) {
    frame[1] = payloadLength;
  } else if (payloadLength < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
    offset += 2;
  } else {
    frame[1] = 127;
    const high = Math.floor(payloadLength / 2 ** 32);
    const low = payloadLength >>> 0;
    frame.writeUInt32BE(high, 2);
    frame.writeUInt32BE(low, 6);
    offset += 8;
  }

  payloadBuffer.copy(frame, offset);
  return frame;
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];

    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;

    let headerSize = 2;
    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerSize += 2;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      payloadLength = high * 2 ** 32 + low;
      headerSize += 8;
    }

    const maskOffset = headerSize;
    const dataOffset = headerSize + (masked ? 4 : 0);
    const frameSize = dataOffset + payloadLength;
    if (offset + frameSize > buffer.length) {
      break;
    }

    if (!fin) {
      frames.push({ opcode: 0x8, payload: Buffer.from("Fragmented frames not supported"), fin: true });
      offset += frameSize;
      continue;
    }

    if (payloadLength > 1_000_000) {
      frames.push({ opcode: 0x8, payload: Buffer.from("Frame too large"), fin: true });
      offset += frameSize;
      continue;
    }

    let payload = buffer.subarray(offset + dataOffset, offset + dataOffset + payloadLength);

    if (masked) {
      const mask = buffer.subarray(offset + maskOffset, offset + maskOffset + 4);
      const unmasked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    frames.push({
      fin,
      opcode,
      payload,
    });

    offset += frameSize;
  }

  return {
    frames,
    remainder: buffer.subarray(offset),
  };
}

async function handleRpc({ agent, method, params }) {
  switch (method) {
    case "gateway.overview":
      return {
        overview: agent.gateway.getOverview(),
        events: agent.gateway.listEvents(50),
        runs: agent.gateway.listRuns(20),
        approvals: agent.gateway.listApprovals(),
      };
    case "agents.list":
      return {
        agents: agent.getState().agents,
      };
    case "agents.get": {
      const agentId = String(params?.agentId || "").trim();
      if (!agentId) {
        throw new Error("agentId is required");
      }
      const item = agent.getState().agents.find((entry) => entry.id === agentId) || null;
      if (!item) {
        throw new Error("Agent not found");
      }
      return { agent: item };
    }
    case "sessions.list":
      return {
        sessions: agent.sessions.listSessions(Number(params?.limit || 50)),
      };
    case "sessions.get": {
      const sessionId = String(params?.sessionId || "").trim();
      if (!sessionId) {
        throw new Error("sessionId is required");
      }
      const session = agent.sessions.getSession(sessionId, {
        messageLimit: Number(params?.messageLimit || 80),
      });
      if (!session) {
        throw new Error("Session not found");
      }
      return { session };
    }
    case "sessions.reset": {
      const sessionId = String(params?.sessionId || "").trim();
      const reason = String(params?.reason || "manual-reset").trim();
      if (!sessionId) {
        throw new Error("sessionId is required");
      }
      const session = agent.sessions.archiveSession(sessionId, reason);
      agent.gateway.addEvent("session.reset", {
        sessionId,
        reason,
      });
      return { session };
    }
    case "memory.overview": {
      const agentId = String(params?.agentId || "").trim();
      return {
        overview: agent.memory.getOverview(agentId),
        longTerm: agent.memory.getLongTermMemory(Number(params?.limit || 50), agentId),
        dreams: agent.memory.getDreams(Number(params?.dreamLimit || 20), agentId),
        candidates: agent.memory.getPromotionCandidates({
          agentId,
          limit: Number(params?.candidateLimit || 12),
        }),
      };
    }
    case "memory.promote": {
      const result = agent.memory.promoteMemory(params || {});
      agent.gateway.addEvent("memory.promoted", {
        memoryId: result.memory.id,
        created: result.created,
        sourceRef: result.memory.sourceRef,
        agentId: result.memory.agentId,
      });
      return result;
    }
    case "memory.dream": {
      const result = agent.memory.runDreamSweep({
        agentId: params?.agentId || "main",
        limit: Number(params?.limit || 5),
        minScore: Number(params?.minScore || 0.65),
        source: "ws",
      });
      agent.gateway.addEvent("memory.dream_completed", {
        dreamId: result.dream.id,
        promotedCount: result.promoted.length,
        agentId: result.dream.agentId,
      });
      return result;
    }
    case "connectors.overview":
      return {
        config: agent.connectors.getPublicConfig(),
        adaptersOverview: agent.connectors.getAdaptersOverview(),
        adapters: agent.connectors.listAdapters(),
        telegramWorker: agent.telegramWorker.getStatus(),
        discordWorker: agent.discordWorker.getStatus(),
        adapterDeliveries: agent.connectors.listAdapterDeliveries({
          limit: Number(params?.adapterLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.adapterStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterOutbox: agent.connectors.listAdapterOutbox({
          limit: Number(params?.outboxLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.outboxStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterAttachmentCache: agent.connectors.listAdapterAttachmentCache({
          limit: Number(params?.cacheLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.cacheStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterAttachmentExtracts: agent.connectors.listAdapterAttachmentExtracts({
          limit: Number(params?.extractLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.extractStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterAttachmentInjections: agent.connectors.listAdapterAttachmentInjections({
          limit: Number(params?.injectLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.injectStatus || "",
          query: params?.adapterQuery || "",
        }),
        overview: agent.connectors.getOverview(),
        webhookDeliveries: agent.connectors.listWebhookDeliveries(Number(params?.limit || 20)),
        fileDropRecords: agent.connectors.listFileDropRecords(Number(params?.limit || 20)),
        pendingFiles: agent.connectors.listPendingFiles({
          limit: Number(params?.pendingLimit || 20),
          agentId: params?.agentId || "",
        }),
      };
    case "connectors.webhook":
      return agent.receiveWebhook(params || {});
    case "connectors.adapters":
      return {
        overview: agent.connectors.getAdaptersOverview(),
        adapters: agent.connectors.listAdapters(),
        telegramWorker: agent.telegramWorker.getStatus(),
        discordWorker: agent.discordWorker.getStatus(),
        adapterDeliveries: agent.connectors.listAdapterDeliveries({
          limit: Number(params?.adapterLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.adapterStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterOutbox: agent.connectors.listAdapterOutbox({
          limit: Number(params?.outboxLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.outboxStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterAttachmentCache: agent.connectors.listAdapterAttachmentCache({
          limit: Number(params?.cacheLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.cacheStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterAttachmentExtracts: agent.connectors.listAdapterAttachmentExtracts({
          limit: Number(params?.extractLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.extractStatus || "",
          query: params?.adapterQuery || "",
        }),
        adapterAttachmentInjections: agent.connectors.listAdapterAttachmentInjections({
          limit: Number(params?.injectLimit || 20),
          adapterId: params?.adapterId || "",
          status: params?.injectStatus || "",
          query: params?.adapterQuery || "",
        }),
      };
    case "connectors.updateAdapter": {
      const result = agent.connectors.setAdapterConfig(params || {});
      agent.gateway.addEvent("connector.adapter_config_updated", {
        adapterId: result.adapter.id,
        enabled: result.adapter.enabled,
        status: result.adapter.status,
        defaultAgentId: result.adapter.defaultAgentId,
        secretUpdated: result.secretUpdated,
      });
      return result;
    }
    case "connectors.testAdapter": {
      const result = agent.connectors.testAdapter(params?.adapterId || params?.id);
      agent.gateway.addEvent("connector.adapter_tested", {
        adapterId: result.adapterId,
        ok: result.ok,
        status: result.status,
      });
      return result;
    }
    case "connectors.retryAdapterOutbox": {
      const outboxId = String(params?.outboxId || params?.id || "").trim();
      if (!outboxId) {
        throw new Error("outboxId is required");
      }
      const item = agent.connectors.getAdapterOutboxItem(outboxId);
      if (item.adapterId === "telegram") {
        return agent.telegramWorker.retryOutbox(item.id);
      }
      if (item.adapterId === "discord") {
        return agent.discordWorker.retryOutbox(item.id);
      }
      throw new Error(`Adapter ${item.adapterId || "(missing)"} does not support retry yet.`);
    }
    case "connectors.cacheAdapterAttachment": {
      const { delivery } = agent.connectors.getAdapterDeliveryAttachment(params || {});
      if (delivery.adapterId === "telegram") {
        return agent.telegramWorker.cacheAttachment(params || {});
      }
      if (delivery.adapterId === "discord") {
        return agent.discordWorker.cacheAttachment(params || {});
      }
      throw new Error(`Adapter ${delivery.adapterId || "(missing)"} does not support attachment caching yet.`);
    }
    case "connectors.extractAdapterAttachment":
      return agent.connectors.extractAdapterAttachmentCache({
        cacheId: params?.cacheId || params?.id,
        deliveryId: params?.deliveryId || "",
        attachmentIndex: Number(params?.attachmentIndex || 0),
        maxBytes: Number(params?.maxBytes || 1_000_000),
        maxChars: Number(params?.maxChars || 12000),
      });
    case "connectors.injectAdapterAttachment":
      return agent.injectAdapterAttachmentExtract({
        extractId: params?.extractId || params?.id,
        agentId: params?.agentId || "",
        sessionId: params?.sessionId || "",
        label: params?.label || "",
        maxChars: Number(params?.maxChars || 12000),
        source: "ws",
      });
    case "connectors.analyzeAdapterAttachment":
      return agent.connectors.analyzeAdapterAttachmentMedia({
        extractId: params?.extractId || params?.id || "",
        cacheId: params?.cacheId || "",
        deliveryId: params?.deliveryId || "",
        attachmentIndex: Number(params?.attachmentIndex || 0),
        force: params?.force === true,
        policy: params?.policy && typeof params.policy === "object" ? params.policy : {},
      });
    case "connectors.analyzePendingAdapterAttachments":
      return agent.connectors.analyzePendingMediaAttachments({
        limit: Number(params?.limit || 5),
        force: params?.force === true,
        policy: params?.policy && typeof params.policy === "object" ? params.policy : {},
      });
    case "connectors.testMediaProvider":
      return agent.connectors.testAttachmentMediaAnalysisProvider({
        mediaKind: params?.mediaKind || "",
        policy: params?.policy && typeof params.policy === "object" ? params.policy : {},
        testArgs: "testArgs" in (params || {}) ? params.testArgs : undefined,
      });
    case "connectors.mediaProviderSetup":
      return agent.connectors.getLocalMediaProviderSetup();
    case "connectors.mediaProviderInstallPlan":
      return agent.connectors.createLocalMediaProviderInstallPlan({
        engineIds: Array.isArray(params?.engineIds) ? params.engineIds : [],
        includeAvailable: params?.includeAvailable === true,
        platform: params?.platform || "",
      });
    case "connectors.ingestAdapterAttachments": {
      const deliveryId = String(params?.deliveryId || params?.id || "").trim();
      if (!deliveryId) {
        throw new Error("deliveryId is required");
      }
      const delivery = agent.connectors.getAdapterDelivery(deliveryId);
      return agent.ingestAdapterDeliveryAttachments(delivery, {
        force: params?.force === true,
        source: "ws",
        policy: params?.policy && typeof params.policy === "object" ? params.policy : {},
      });
    }
    case "connectors.cleanupAdapterAttachments":
      return agent.connectors.cleanupAdapterAttachmentCache({
        dryRun: params?.dryRun !== false,
        force: params?.force === true,
        policy: params?.policy && typeof params.policy === "object" ? params.policy : {},
      });
    case "connectors.telegramStatus":
      return {
        telegramWorker: agent.telegramWorker.getStatus(),
      };
    case "connectors.telegramStart":
      return {
        telegramWorker: agent.telegramWorker.start({
          intervalMs: Number(params?.intervalMs || 5000),
          limit: Number(params?.limit || 10),
          runNow: params?.runNow !== false,
        }),
      };
    case "connectors.telegramStop":
      return {
        telegramWorker: agent.telegramWorker.stop(params?.reason || "ws-stop"),
      };
    case "connectors.telegramPoll":
      return agent.telegramWorker.pollOnce({
        limit: Number(params?.limit || 10),
        timeoutSeconds: Number(params?.timeoutSeconds || 1),
        offset: params?.offset,
        mockUpdates: Array.isArray(params?.mockUpdates) ? params.mockUpdates : undefined,
        reply: params?.reply !== false,
        source: "ws",
      });
    case "connectors.discordStatus":
      return {
        discordWorker: agent.discordWorker.getStatus(),
      };
    case "connectors.discordStart":
      return {
        discordWorker: agent.discordWorker.start({
          connectNow: params?.connectNow !== false,
        }),
      };
    case "connectors.discordStop":
      return {
        discordWorker: agent.discordWorker.stop(params?.reason || "ws-stop"),
      };
    case "connectors.discordDispatch":
      return agent.discordWorker.dispatch({
        mockEvents: Array.isArray(params?.mockEvents) ? params.mockEvents : undefined,
        event: params?.event,
        payload: params?.payload,
        reply: Boolean(params?.reply),
        source: "ws",
      });
    case "connectors.updateConfig": {
      const result = agent.connectors.updateConfig(params || {});
      agent.gateway.addEvent("connector.config_updated", {
        webhookEnabled: result.config.webhook.enabled,
        webhookDefaultAgentId: result.config.webhook.defaultAgentId,
        webhookAllowPayloadAgent: result.config.webhook.allowPayloadAgent,
        webhookRequireToken: result.config.webhook.requireToken,
        fileDropEnabled: result.config.fileDrop.enabled,
        fileDropDefaultAgentId: result.config.fileDrop.defaultAgentId,
        fileDropArchiveProcessed: result.config.fileDrop.archiveProcessed,
      });
      return result;
    }
    case "connectors.rotateWebhookToken": {
      const result = agent.connectors.rotateWebhookToken();
      agent.gateway.addEvent("connector.webhook_token_rotated", {
        tokenPreview: result.config.webhook.tokenPreview,
        tokenRotatedAt: result.config.webhook.tokenRotatedAt,
      });
      return result;
    }
    case "connectors.scanFileDrop":
      return agent.scanFileDrop({
        agentId: params?.agentId || "",
        limit: Number(params?.limit || 10),
      });
    case "agent.send": {
      const message = String(params?.message || "").trim();
      if (!message) {
        throw new Error("message is required");
      }
      return agent.handleMessage(message, {
        sessionId: params?.sessionId,
        label: params?.label,
        agentId: params?.agentId,
        channel: params?.channel,
      });
    }
    case "delegations.list":
      return {
        delegations: agent.gateway.listDelegations({
          limit: Number(params?.limit || 50),
          status: params?.status || "",
          agentId: params?.agentId || "",
        }),
      };
    case "delegations.create":
      return agent.queueDelegation({
        sourceAgentId: params?.sourceAgentId || "main",
        targetAgentId: params?.targetAgentId || params?.agentId,
        instruction: params?.instruction || params?.task,
        parentSessionId: params?.parentSessionId || params?.sessionId || "",
        parentRunId: params?.parentRunId || "",
        source: params?.source || "ws-rpc",
      });
    case "delegations.cancel":
      return agent.cancelDelegation(params?.delegationId || params?.id, params?.note || "ws-cancel");
    case "delegations.retry":
      return agent.retryDelegation(params?.delegationId || params?.id, {
        sourceAgentId: params?.sourceAgentId || "",
        targetAgentId: params?.targetAgentId || "",
        instruction: params?.instruction || "",
        parentSessionId: params?.parentSessionId || "",
        parentRunId: params?.parentRunId || "",
        source: params?.source || "ws-retry",
      });
    case "approvals.list":
      return {
        approvals: agent.gateway.listApprovals(String(params?.status || "").trim()),
      };
    case "approvals.resolve": {
      const approvalId = String(params?.approvalId || "").trim();
      const decision = String(params?.decision || "").trim();
      const note = String(params?.note || "").trim();
      if (!approvalId || !decision) {
        throw new Error("approvalId and decision are required");
      }
      return agent.resolveApproval(approvalId, decision, note);
    }
    case "shell.audit":
      return {
        overview: agent.shellAudit.getOverview(),
        policy: agent.shellExecutor.getPolicy(),
        records: agent.shellAudit.list({
          limit: Number(params?.limit || 50),
          status: String(params?.status || "").trim(),
          risk: String(params?.risk || "").trim(),
          query: String(params?.query || "").trim(),
        }),
      };
    case "shell.updatePolicy": {
      const result = agent.customizationEngine.updateShellPolicy(params || {});
      agent.gateway.addEvent("shell.policy_updated", {
        allowlistMode: result.config.tools?.shellExecution?.allowlistMode,
        timeoutMs: result.config.tools?.shellExecution?.timeoutMs,
        maxOutputBytes: result.config.tools?.shellExecution?.maxOutputBytes,
      });
      return {
        ...result,
        policy: agent.shellExecutor.getPolicy(),
      };
    }
    case "trust.overview":
      return {
        overview: agent.trust.getOverview(),
        devices: agent.trust.listDevices(),
        pairingRequests: agent.trust.listPairingRequests(String(params?.status || "").trim()),
      };
    case "trust.requestPairing": {
      const result = agent.trust.requestPairing({
        label: params?.label,
        role: params?.role,
        fingerprint: params?.fingerprint,
        remoteAddress: "ws",
      });
      agent.gateway.addEvent(result.tokenRequired ? "trust.device_token_required" : "trust.pairing_requested", {
        requestId: result.request?.id || "",
        deviceId: result.device?.id || "",
        role: result.request?.role || result.device?.role || params?.role || "operator",
        fingerprint: result.request?.fingerprint || result.device?.fingerprint || "",
      });
      return result;
    }
    case "trust.approvePairing": {
      const requestId = String(params?.requestId || "").trim();
      if (!requestId) {
        throw new Error("requestId is required");
      }
      const result = agent.trust.approvePairing(requestId, String(params?.note || "ws-approval").trim());
      agent.gateway.addEvent("trust.pairing_approved", {
        requestId,
        deviceId: result.device.id,
        role: result.device.role,
      });
      return result;
    }
    case "trust.rejectPairing": {
      const requestId = String(params?.requestId || "").trim();
      if (!requestId) {
        throw new Error("requestId is required");
      }
      const request = agent.trust.rejectPairing(requestId, String(params?.note || "ws-rejection").trim());
      agent.gateway.addEvent("trust.pairing_rejected", {
        requestId,
        role: request.role,
      });
      return { request };
    }
    case "trust.revokeDevice": {
      const deviceId = String(params?.deviceId || "").trim();
      if (!deviceId) {
        throw new Error("deviceId is required");
      }
      const device = agent.trust.revokeDevice(deviceId, String(params?.note || "ws-revoke").trim());
      agent.gateway.addEvent("trust.device_revoked", {
        deviceId,
        role: device.role,
      });
      return { device };
    }
    case "trust.rotateDeviceToken": {
      const deviceId = String(params?.deviceId || "").trim();
      if (!deviceId) {
        throw new Error("deviceId is required");
      }
      const result = agent.trust.rotateDeviceToken(deviceId, String(params?.note || "ws-token-rotation").trim());
      agent.gateway.addEvent("trust.device_token_rotated", {
        deviceId,
        role: result.device.role,
      });
      return result;
    }
    case "trust.rotateGatewayToken": {
      const result = agent.trust.rotateGatewayToken();
      agent.gateway.addEvent("trust.gateway_token_rotated", {
        rotatedAt: result.status.rotatedAt,
      });
      return result;
    }
    case "trust.revokeGatewayToken": {
      const status = agent.trust.revokeGatewayToken(String(params?.note || "ws-gateway-revoke").trim());
      agent.gateway.addEvent("trust.gateway_token_revoked", {
        revokedAt: status.revokedAt,
      });
      return { status };
    }
    case "skills.list":
      return { skills: agent.skills.getAll(String(params?.agentId || "").trim()) };
    case "skills.create":
      return agent.tools.run("create_skill", params || {}, {
        agentId: params?.agentId || "main",
      });
    case "config.get": {
      const state = agent.getState();
      return {
        config: state.config,
        runtime: state.runtime,
        provider: state.provider,
      };
    }
    case "config.update":
      return agent.tools.run("update_runtime_settings", params || {});
    case "provider.applyProfile": {
      const result = await agent.tools.run("apply_provider_profile", params || {});
      agent.gateway.addEvent("provider.profile_applied", {
        profileId: params?.profileId,
      });
      return result;
    }
    case "provider.setKey": {
      const result = await agent.tools.run("set_provider_key", params || {});
      agent.gateway.addEvent("provider.key_updated", {
        providerId: params?.providerId || "openai-compatible",
        configured: Boolean(result.status?.configured),
      });
      return result;
    }
    case "provider.keyStatus":
      return await agent.tools.run("get_provider_key_status", params || {});
    case "provider.test":
      return await agent.tools.run("test_provider_profile", params || {});
    case "workspace.status":
      return agent.getWorkspaceState();
    case "schedules.list":
      return {
        overview: agent.scheduler.getOverview(),
        schedules: agent.schedules.listSchedules(Number(params?.limit || 50)),
      };
    case "schedules.create": {
      const tool = String(params?.tool || "").trim();
      if (!tool) {
        throw new Error("tool is required");
      }
      // Support natural language intervals ("5m", "1h", "2d") and cron expressions
      // intervalSeconds is numeric (backward compat), interval is string ("5m", "1h30m")
      const scheduleInput = {
        name: String(params?.name || `${tool} schedule`).trim(),
        tool,
        input: params?.input || {},
        agentId: params?.agentId || "main",
        maxRuns: Number(params?.maxRuns || 0),
        runNow: Boolean(params?.runNow),
        source: "ws",
        retry: {
          maxAttempts: Number(params?.retryMaxAttempts || 1),
          delayMs: Number(params?.retryDelaySeconds || 5) * 1000,
        },
      };

      // Prefer natural interval string, then cron, then numeric intervalSeconds
      if (params?.interval && typeof params.interval === "string") {
        scheduleInput.interval = params.interval; // "5m", "1h", "2d", "1h30m"
      } else if (params?.cron && typeof params.cron === "string") {
        scheduleInput.cron = params.cron; // Raw cron expression
      } else {
        // Legacy: intervalSeconds as number
        scheduleInput.intervalMs = Number(params?.intervalSeconds || 60) * 1000;
      }

      return {
        schedule: agent.scheduler.createSchedule(scheduleInput),
      };
    }
    case "schedules.run": {
      const scheduleId = String(params?.scheduleId || "").trim();
      if (!scheduleId) {
        throw new Error("scheduleId is required");
      }
      return agent.scheduler.runNow(scheduleId, "ws");
    }
    case "schedules.toggle": {
      const scheduleId = String(params?.scheduleId || "").trim();
      if (!scheduleId) {
        throw new Error("scheduleId is required");
      }
      return {
        schedule: agent.scheduler.setStatus(scheduleId, params?.status || "paused"),
      };
    }
    case "schedules.delete": {
      const scheduleId = String(params?.scheduleId || "").trim();
      if (!scheduleId) {
        throw new Error("scheduleId is required");
      }
      return {
        schedule: agent.scheduler.deleteSchedule(scheduleId),
      };
    }
    case "plugins.list":
      return {
        plugins: agent.plugins.getAll(),
        tools: agent.plugins.getToolDefinitions(),
      };
    case "plugins.get": {
      const pluginId = String(params?.pluginId || "").trim();
      if (!pluginId) {
        throw new Error("pluginId is required");
      }
      const plugin = agent.plugins.getDetail(pluginId);
      if (!plugin) {
        throw new Error("Plugin not found");
      }
      return { plugin };
    }
    case "plugins.reload":
      return {
        plugins: agent.refreshPlugins("ws-reload"),
      };
    case "plugins.toggle": {
      const pluginId = String(params?.pluginId || "").trim();
      if (!pluginId) {
        throw new Error("pluginId is required");
      }
      const plugin = agent.plugins.setEnabled(pluginId, Boolean(params?.enabled));
      agent.gateway.addEvent("plugin.toggled", {
        pluginId,
        enabled: plugin.enabled,
      });
      agent.refreshPlugins("ws-toggle");
      return plugin;
    }
    case "plugins.updateConfig": {
      const pluginId = String(params?.pluginId || "").trim();
      if (!pluginId) {
        throw new Error("pluginId is required");
      }
      const plugin = agent.plugins.updatePluginConfig(pluginId, params?.config || {});
      agent.gateway.addEvent("plugin.config_updated", { pluginId });
      agent.refreshPlugins("ws-config-update");
      return plugin;
    }
    case "jobs.list":
      return {
        jobs: agent.jobs.listJobs(Number(params?.limit || 50)),
      };
    case "jobs.enqueueTool": {
      const tool = String(params?.tool || "").trim();
      if (!tool) {
        throw new Error("tool is required");
      }
      return agent.worker.enqueueToolJob({
        tool,
        input: params?.input || {},
        source: "ws",
        agentId: params?.agentId || "main",
        scheduleId: params?.scheduleId || "",
        runAt: params?.runAt || "",
        retry: {
          maxAttempts: Number(params?.retryMaxAttempts || params?.retry?.maxAttempts || 1),
          delayMs: Number(params?.retryDelaySeconds || 5) * 1000,
        },
      });
    }
    case "jobs.cancel": {
      const jobId = String(params?.jobId || "").trim();
      if (!jobId) {
        throw new Error("jobId is required");
      }
      return {
        job: agent.worker.cancelJob(jobId, String(params?.reason || "ws-cancel").trim()),
      };
    }
    case "autonomous.execute": {
      // Execute autonomous task with Think-Act-Observe-Reflect loop
      // User can trigger this directly without LLM prompt
      const objective = String(params?.objective || params?.task || params?.request || "").trim();
      if (!objective) {
        throw new Error("objective/task/request is required");
      }

      const maxIterations = Number(params?.maxIterations || 200);
      const checkpointEnabled = Boolean(params?.checkpointEnabled !== false);
      const daemonMode = Boolean(params?.daemonMode || false);

      // Check if autonomousRuntime exists
      if (!agent.autonomousRuntime) {
        throw new Error("Autonomous runtime not initialized");
      }

      // Set execution parameters
      const previousMax = agent.autonomousRuntime.executionState.maxIterations;
      agent.autonomousRuntime.executionState.maxIterations = Math.max(1, Math.min(10000, maxIterations));
      agent.autonomousRuntime.executionState.currentIteration = 0;

      // Execute the task
      const result = await agent.autonomousRuntime.executeTask(objective, {
        agentId: params?.agentId || "main",
        sessionId: params?.sessionId || "autonomous-ws-session",
        checkpointEnabled,
        daemonMode,
        tools: agent.tools?.getAll?.({ agentId: params?.agentId || "main", modelCallableOnly: true }) || [],
        skills: agent.skills?.list?.() || [],
      });

      // Restore original max
      agent.autonomousRuntime.executionState.maxIterations = previousMax;

      // Emit completion event
      agent.gatewayStore.addEvent("autonomous.completed", {
        objective,
        success: result.success,
        iterations: result.executionStats?.currentIteration || 0,
        duration: result.executionStats?.totalDurationMs || 0,
      });

      return {
        success: result.success,
        objective,
        iterations: result.executionStats?.currentIteration || 0,
        maxIterations: maxIterations,
        results: result.results || [],
        goal: result.goal ? {
          id: result.goal.id,
          title: result.goal.title,
          status: result.goal.status,
        } : null,
        executionStats: result.executionStats,
      };
    }
    case "autonomous.status": {
      // Get autonomous runtime status
      if (!agent.autonomousRuntime) {
        return { initialized: false };
      }
      const state = agent.autonomousRuntime.executionState;
      return {
        initialized: true,
        currentGoal: state.currentGoal?.title || null,
        currentIteration: state.currentIteration || 0,
        maxIterations: state.maxIterations || 10,
        executionHistory: (state.executionHistory || []).length,
        reflectionLog: (state.reflectionLog || []).length,
      };
    }
    case "autonomous.checkpoint": {
      // Save or load checkpoint for autonomous task
      const action = String(params?.action || "save").trim();
      const taskId = String(params?.taskId || "").trim();

      if (action === "save") {
        // Save current state
        const checkpointData = {
          taskId,
          timestamp: new Date().toISOString(),
          state: agent.autonomousRuntime?.executionState || {},
          goalStack: agent.autonomousRuntime?.goalManager?.goalStack || [],
        };
        return {
          saved: true,
          checkpointId: `checkpoint_${Date.now()}`,
          data: checkpointData,
        };
      } else if (action === "load") {
        // Load from checkpoint (would need checkpoint store implementation)
        return {
          loaded: false,
          reason: "Checkpoint store not yet implemented",
        };
      }
      throw new Error(`Unknown checkpoint action: ${action}`);
    }
    case "autonomous.daemon.start": {
      // Start the autonomous daemon
      agent.autonomousDaemon?.start();
      return {
        started: true,
        status: agent.autonomousDaemon?.getStatus() || {},
      };
    }
    case "autonomous.daemon.stop": {
      // Stop the autonomous daemon
      agent.autonomousDaemon?.stop();
      return {
        stopped: true,
        status: agent.autonomousDaemon?.getStatus() || {},
      };
    }
    case "autonomous.daemon.enqueue": {
      // Add a task to the daemon queue
      const objective = String(params?.objective || params?.task || "").trim();
      if (!objective) {
        throw new Error("objective/task is required");
      }
      const taskId = agent.autonomousDaemon?.enqueue({
        objective,
        priority: Number(params?.priority || 0),
        maxIterations: Math.max(1, Math.min(10000, Number(params?.maxIterations || 200))),
        context: params?.context || {},
      });
      return {
        enqueued: true,
        taskId,
        queueLength: agent.autonomousDaemon?.taskQueue?.length || 0,
      };
    }
    case "autonomous.daemon.status": {
      // Get daemon status
      return agent.autonomousDaemon?.getStatus() || { running: false };
    }
    case "autonomous.daemon.clear": {
      // Clear the task queue
      return agent.autonomousDaemon?.clearQueue() || { cleared: 0 };
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

class WsConnection {
  static connectAttempts = new Map();

  constructor({ socket, agent, connections }) {
    this.id = createId("conn");
    this.socket = socket;
    this.agent = agent;
    this.connections = connections;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.role = "";
    this.scopes = [];
    this.device = null;
    this.auth = "";
    this.closed = false;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => this.onClose());
  }

  canAttemptConnect() {
    const key = this.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempts = WsConnection.connectAttempts.get(key) || [];
    const recent = attempts.filter((ts) => now - ts < CONNECT_ATTEMPT_WINDOW_MS);
    if (recent.length >= CONNECT_ATTEMPT_LIMIT) {
      WsConnection.connectAttempts.set(key, recent);
      return false;
    }
    recent.push(now);
    WsConnection.connectAttempts.set(key, recent);
    return true;
  }

  send(obj) {
    if (this.closed) {
      return;
    }
    const payload = JSON.stringify(obj);
    this.socket.write(encodeFrame(0x1, payload));
  }

  sendError(message, code = "bad_request") {
    this.send({
      type: "event",
      event: "gateway.error",
      payload: { code, message },
      at: new Date().toISOString(),
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      // ignore
    }
    this.socket.end();
  }

  async onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const decoded = decodeFrames(this.buffer);
    this.buffer = decoded.remainder;

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }

      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(0xA, frame.payload));
        continue;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(frame.payload.toString("utf8"));
      } catch (error) {
        this.sendError("Invalid JSON");
        continue;
      }

      await this.handleMessage(message);
    }
  }

  onClose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connections.delete(this);
  }

  async handleMessage(message) {
    if (!this.connected) {
      if (!this.canAttemptConnect()) {
        this.send({
          type: "rate_limited",
          ok: false,
          connectionId: this.id,
          retryAfterMs: CONNECT_ATTEMPT_WINDOW_MS,
          at: new Date().toISOString(),
        });
        this.close();
        return;
      }
      if (message?.type !== "connect") {
        this.sendError("First message must be {type:'connect'}", "connect_required");
        this.close();
        return;
      }

      const role = normalizeRole(message.role);
      const label = String(message.label || message.deviceLabel || `${role} connection`).trim();
      const fingerprint = String(message.fingerprint || message.deviceFingerprint || "").trim();
      const gatewayToken = String(message.gatewayToken || "").trim();
      const deviceToken = String(message.deviceToken || message.token || "").trim();
      const deviceId = String(message.deviceId || "").trim();
      let connectEvent = null;

      if (gatewayToken && this.agent.trust.verifyGatewayToken(gatewayToken)) {
        this.role = role;
        this.scopes = scopesForRole(role);
        this.connected = true;
        this.auth = "gateway-token";
        connectEvent = {
          event: "ws.connected",
          payload: {
            connectionId: this.id,
            role: this.role,
            auth: this.auth,
          },
        };
      } else {
        const device = deviceToken ? this.agent.trust.verifyDevice({ deviceId, token: deviceToken }) : null;
        if (device) {
          this.role = normalizeRole(device.role);
          this.scopes = device.scopes || scopesForRole(device.role);
          this.device = device;
          this.connected = true;
          this.auth = "device-token";
          connectEvent = {
            event: "trust.device_connected",
            payload: {
              connectionId: this.id,
              deviceId: device.id,
              role: this.role,
            },
          };
        }
      }

      if (!this.connected) {
        const result = this.agent.trust.requestPairing({
          label,
          role,
          fingerprint,
          remoteAddress: this.socket.remoteAddress || "",
        });
        const eventName = result.tokenRequired ? "trust.device_token_required" : "trust.pairing_requested";
        this.agent.gateway.addEvent(eventName, {
          connectionId: this.id,
          requestId: result.request?.id || "",
          deviceId: result.device?.id || "",
          role: result.request?.role || result.device?.role || role,
          fingerprint: result.request?.fingerprint || result.device?.fingerprint || fingerprint,
        });
        this.send({
          type: result.tokenRequired ? "device_token_required" : "pairing_required",
          ok: false,
          connectionId: this.id,
          request: result.request || null,
          device: result.device || null,
          tokenRequired: Boolean(result.tokenRequired),
          at: new Date().toISOString(),
        });
        return;
      }

      this.send({
        type: "connected",
        ok: true,
        connectionId: this.id,
        role: this.role,
        scopes: this.scopes,
        auth: this.auth,
        device: this.device,
        at: new Date().toISOString(),
      });
      if (connectEvent) {
        this.agent.gateway.addEvent(connectEvent.event, connectEvent.payload);
      }
      return;
    }

    if (message?.type !== "req") {
      this.sendError("Unknown message type", "unknown_type");
      return;
    }

    const id = String(message.id || "").trim();
    const method = String(message.method || "").trim();
    const params = message.params || {};

    if (!id || !method) {
      this.send({
        type: "res",
        id: id || "missing",
        ok: false,
        error: { message: "id and method are required" },
      });
      return;
    }

    const requiredScopes = RPC_SCOPE_RULES[method];
    if (requiredScopes && !scopesAllow(requiredScopes, this.scopes)) {
      this.agent.gateway.addEvent("ws.rpc_denied", {
        connectionId: this.id,
        method,
        role: this.role,
        requiredScopes,
        scopes: this.scopes,
      });
      this.send({
        type: "res",
        id,
        ok: false,
        error: {
          code: "forbidden",
          message: `Method ${method} requires one of: ${requiredScopes.join(", ")}`,
          requiredScopes,
          scopes: this.scopes,
        },
      });
      return;
    }

    try {
      const payload = await handleRpc({ agent: this.agent, method, params });
      this.send({
        type: "res",
        id,
        ok: true,
        payload,
      });
    } catch (error) {
      this.send({
        type: "res",
        id,
        ok: false,
        error: { message: error.message },
      });
    }
  }
}

export function attachWsGateway({ server, agent, pathname = "/ws", handler = null }) {
 let pingInterval = null;
  const connections = new Set();

  if (handler) {
    server.on("upgrade", (req, socket) => {
      try {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (url.pathname !== pathname) {
          return;
        }

        const upgrade = String(req.headers.upgrade || "").toLowerCase();
        const key = req.headers["sec-websocket-key"];
        if (upgrade !== "websocket" || !key) {
          socket.destroy();
          return;
        }

        const accept = computeAcceptValue(String(key));
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
        );

        handler(socket, req);
      } catch {
        socket.destroy();
      }
    });
    return;
  }

  agent.gateway.onEvent((record) => {
    const message = {
      type: "event",
      ...record,
    };
    for (const connection of connections) {
      if (!connection.connected) {
        continue;
      }
      connection.send(message);
    }
  });

  server.on("upgrade", (req, socket) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== pathname) {
        socket.destroy();
        return;
      }

      const upgrade = String(req.headers.upgrade || "").toLowerCase();
      const key = req.headers["sec-websocket-key"];
      if (upgrade !== "websocket" || !key) {
        socket.destroy();
        return;
      }

      const accept = computeAcceptValue(String(key));
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );

      const connection = new WsConnection({ socket, agent, connections });
      connections.add(connection);
    } catch {
      socket.destroy();
    }
  });
}
