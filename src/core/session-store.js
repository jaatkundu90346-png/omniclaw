import fs from "node:fs";
import path from "node:path";

const STORE_VERSION = 2;

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function truncatePreview(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sortByUpdatedAtDesc(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
  const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
  return rightTime - leftTime;
}

export class SessionStore {
  constructor(rootDir, configStore = null) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.filePath = path.join(rootDir, "data", "sessions.json");
    this.sessionDir = path.join(rootDir, "data", "sessions");
    this.transcriptsDir = path.join(this.sessionDir, "transcripts");
    this.ensureStorage();
  }

  ensureStorage() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.mkdirSync(this.transcriptsDir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.write(this.createEmptyStore());
      return;
    }

    this.read();
  }

  createEmptyStore() {
    return {
      version: STORE_VERSION,
      sessions: [],
    };
  }

  getSettings() {
    const config = this.configStore?.getConfig?.() || {};
    const sessionConfig = config.session || {};
    return {
      detailMessageLimit: Number(sessionConfig.detailMessageLimit || 80),
      previewChars: Number(sessionConfig.previewChars || 140),
      autoResetIdleMinutes: Number(sessionConfig.autoResetIdleMinutes || 0),
    };
  }

  readRaw() {
    return safeJsonParse(fs.readFileSync(this.filePath, "utf8"), this.createEmptyStore());
  }

  read() {
    const parsed = this.readRaw();
    if (Number(parsed.version || 0) !== STORE_VERSION) {
      return this.migrateLegacyStore(parsed);
    }

    const data = {
      version: STORE_VERSION,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map((session) => this.normalizeSession(session)) : [],
    };

    let changed = false;
    for (const session of data.sessions) {
      changed = this.ensureTranscriptArtifacts(session) || changed;
    }

    if (changed) {
      this.write(data);
    }
    return data;
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  migrateLegacyStore(parsed) {
    const legacySessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(this.sessionDir, `sessions.legacy-backup.${timestamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(parsed, null, 2));

    const migrated = this.createEmptyStore();
    for (const legacySession of legacySessions) {
      const session = this.normalizeSession({
        ...legacySession,
        messages: undefined,
      });
      const messages = Array.isArray(legacySession.messages) ? legacySession.messages : [];
      this.ensureTranscriptArtifacts(session, { overwrite: true, seedMessages: messages });
      migrated.sessions.push(session);
    }

    this.write(migrated);
    return migrated;
  }

  normalizeSession(session) {
    const createdAt = session.createdAt || new Date().toISOString();
    const updatedAt = session.updatedAt || createdAt;
    const transcriptPath = session.transcriptPath || this.buildTranscriptRelativePath(session.id);
    return {
      id: String(session.id || createId("session")),
      key: String(session.key || `agent:main:webchat:main`),
      label: String(session.label || "main"),
      agentId: String(session.agentId || "main"),
      channel: String(session.channel || "webchat"),
      status: String(session.status || "idle"),
      lifecycleState: String(session.lifecycleState || "active"),
      createdAt,
      updatedAt,
      lastMessageAt: session.lastMessageAt || null,
      lastRunAcceptedAt: session.lastRunAcceptedAt || null,
      lastRunCompletedAt: session.lastRunCompletedAt || null,
      endedAt: session.endedAt || null,
      messageCount: Number(session.messageCount || 0),
      runCount: Number(session.runCount || 0),
      activeRunId: session.activeRunId || null,
      queueDepth: Number(session.queueDepth || 0),
      queuedRunIds: Array.isArray(session.queuedRunIds) ? session.queuedRunIds.map(String) : [],
      parentSessionId: session.parentSessionId || null,
      resetReason: session.resetReason || null,
      lastUserMessagePreview: String(session.lastUserMessagePreview || ""),
      lastAssistantPreview: String(session.lastAssistantPreview || ""),
      transcriptPath,
    };
  }

  buildTranscriptRelativePath(sessionId) {
    return path.join("data", "sessions", "transcripts", `${sessionId}.jsonl`);
  }

  getTranscriptAbsolutePath(session) {
    return path.join(this.rootDir, session.transcriptPath || this.buildTranscriptRelativePath(session.id));
  }

  ensureTranscriptArtifacts(session, options = {}) {
    const { overwrite = false, seedMessages = [] } = options;
    const transcriptPath = this.getTranscriptAbsolutePath(session);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

    if (overwrite || !fs.existsSync(transcriptPath) || fs.statSync(transcriptPath).size === 0) {
      const lines = [
        JSON.stringify({
          type: "session",
          sessionId: session.id,
          sessionKey: session.key,
          label: session.label,
          agentId: session.agentId,
          channel: session.channel,
          createdAt: session.createdAt,
        }),
      ];

      for (const message of seedMessages) {
        lines.push(
          JSON.stringify({
            type: "message",
            sessionId: session.id,
            id: message.id || createId("message"),
            role: message.role || "assistant",
            at: message.at || session.createdAt,
            text: message.text || "",
            toolOutputs: Array.isArray(message.toolOutputs) ? message.toolOutputs : undefined,
          }),
        );
      }

      fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
      return true;
    }

    return false;
  }

  buildSessionKey({ label = "main", agentId = "main", channel = "webchat" } = {}) {
    return `agent:${agentId}:${channel}:${label}`;
  }

  summarizeSession(session) {
    const settings = this.getSettings();
    const lastActivity = session.lastMessageAt || session.updatedAt || session.createdAt;
    const idleMinutes = lastActivity
      ? Math.max(0, Math.floor((Date.now() - Date.parse(lastActivity)) / 60_000))
      : 0;
    const stale = settings.autoResetIdleMinutes > 0 && idleMinutes >= settings.autoResetIdleMinutes;

    return {
      id: session.id,
      key: session.key,
      label: session.label,
      agentId: session.agentId,
      channel: session.channel,
      status: session.status,
      lifecycleState: session.lifecycleState,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastMessageAt: session.lastMessageAt,
      lastRunAcceptedAt: session.lastRunAcceptedAt,
      lastRunCompletedAt: session.lastRunCompletedAt,
      endedAt: session.endedAt,
      messageCount: session.messageCount,
      runCount: session.runCount,
      activeRunId: session.activeRunId,
      queueDepth: session.queueDepth,
      queuedRunIds: session.queuedRunIds,
      parentSessionId: session.parentSessionId,
      resetReason: session.resetReason,
      transcriptPath: session.transcriptPath,
      lastUserMessagePreview: session.lastUserMessagePreview,
      lastAssistantPreview: session.lastAssistantPreview,
      idleMinutes,
      stale,
    };
  }

  listSessions(limit = 50) {
    const sessions = [...this.read().sessions].sort(sortByUpdatedAtDesc).slice(0, limit);
    return sessions.map((session) => this.summarizeSession(session));
  }

  findSessionIndex(data, sessionId) {
    return data.sessions.findIndex((session) => session.id === sessionId);
  }

  findSession(data, sessionId) {
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      return null;
    }
    return data.sessions[index];
  }

  shouldAutoReset(session) {
    const settings = this.getSettings();
    if (settings.autoResetIdleMinutes <= 0 || session.activeRunId || !session.lastMessageAt) {
      return false;
    }

    const idleMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(session.lastMessageAt)) / 60_000));
    return idleMinutes >= settings.autoResetIdleMinutes;
  }

  createSession({ key, label, agentId, channel, parentSessionId = null, resetReason = null }) {
    const now = new Date().toISOString();
    const session = this.normalizeSession({
      id: createId("session"),
      key,
      label,
      agentId,
      channel,
      status: "idle",
      lifecycleState: "active",
      createdAt: now,
      updatedAt: now,
      queueDepth: 0,
      queuedRunIds: [],
      parentSessionId,
      resetReason,
    });
    this.ensureTranscriptArtifacts(session, { overwrite: true });
    return session;
  }

  resolveSession({ sessionId = "", label = "main", agentId = "main", channel = "webchat", parentSessionId = null } = {}) {
    const data = this.read();
    let changed = false;
    let resolved = null;
    const requestedId = String(sessionId || "").trim();

    if (requestedId) {
      resolved = this.findSession(data, requestedId);
    } else {
      const key = this.buildSessionKey({ label, agentId, channel });
      const matchingSessions = data.sessions.filter((session) => session.key === key).sort(sortByUpdatedAtDesc);
      const activeSessions = data.sessions
        .filter((session) => session.key === key && session.lifecycleState !== "archived")
        .sort(sortByUpdatedAtDesc);
      resolved = activeSessions[0] || null;

      if (resolved && this.shouldAutoReset(resolved)) {
        this.archiveSessionInData(data, resolved.id, "idle-timeout");
        changed = true;
        resolved = null;
      }

      if (!resolved) {
        const resolvedParentSessionId = parentSessionId || (matchingSessions.length > 0 ? matchingSessions[0].id : null);
        resolved = this.createSession({
          key,
          label,
          agentId,
          channel,
          parentSessionId: resolvedParentSessionId,
          resetReason: null,
        });
        data.sessions.push(resolved);
        changed = true;
      }
    }

    if (!resolved) {
      return null;
    }

    changed = this.ensureTranscriptArtifacts(resolved) || changed;
    if (changed) {
      this.write(data);
    }

    return this.summarizeSession(resolved);
  }

  appendTranscriptEntryInData(session, entry) {
    const line = {
      sessionId: session.id,
      at: entry.at || new Date().toISOString(),
      ...entry,
    };
    const transcriptPath = this.getTranscriptAbsolutePath(session);
    fs.appendFileSync(transcriptPath, `${JSON.stringify(line)}\n`);
    return line;
  }

  appendMessage(sessionId, message) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    const at = message.at || new Date().toISOString();
    const entry = this.appendTranscriptEntryInData(session, {
      type: "message",
      id: message.id || createId("message"),
      role: String(message.role || "assistant"),
      text: String(message.text || ""),
      toolOutputs: Array.isArray(message.toolOutputs) ? message.toolOutputs : undefined,
      at,
    });

    const settings = this.getSettings();
    session.messageCount += 1;
    session.lastMessageAt = at;
    session.updatedAt = at;
    if (entry.role === "user") {
      session.lastUserMessagePreview = truncatePreview(entry.text, settings.previewChars);
    }
    if (entry.role === "assistant") {
      session.lastAssistantPreview = truncatePreview(entry.text, settings.previewChars);
    }
    data.sessions[index] = session;
    this.write(data);
    return this.summarizeSession(session);
  }

  appendSystemEvent(sessionId, event, payload = {}) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    const at = payload.at || new Date().toISOString();
    this.appendTranscriptEntryInData(session, {
      type: "event",
      event,
      payload,
      at,
    });
    session.updatedAt = at;
    data.sessions[index] = session;
    this.write(data);
    return this.summarizeSession(session);
  }

  startRun(sessionId, { runId, message = "", at = new Date().toISOString() } = {}) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    if (session.lifecycleState === "archived") {
      return {
        ok: false,
        reason: "archived",
        session: this.summarizeSession(session),
      };
    }
    if (session.activeRunId && session.activeRunId !== runId) {
      return {
        ok: false,
        reason: "busy",
        activeRunId: session.activeRunId,
        session: this.summarizeSession(session),
      };
    }

    session.activeRunId = runId;
    session.status = "running";
    session.runCount += 1;
    session.lastRunAcceptedAt = at;
    session.updatedAt = at;
    this.appendTranscriptEntryInData(session, {
      type: "run",
      phase: "accepted",
      runId,
      summary: truncatePreview(message, this.getSettings().previewChars),
      at,
    });
    data.sessions[index] = session;
    this.write(data);
    return {
      ok: true,
      session: this.summarizeSession(session),
    };
  }

  markRunStage(sessionId, runId, phase, payload = {}) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    const at = payload.at || new Date().toISOString();
    this.appendTranscriptEntryInData(session, {
      type: "run",
      phase,
      runId,
      payload,
      at,
    });
    session.updatedAt = at;
    if (phase === "started") {
      session.status = "running";
    }
    data.sessions[index] = session;
    this.write(data);
    return this.summarizeSession(session);
  }

  finishRun(sessionId, runId, { status = "idle", at = new Date().toISOString(), error = "", approvalIds = [] } = {}) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    this.appendTranscriptEntryInData(session, {
      type: "run",
      phase: status === "error" ? "failed" : status === "awaiting-approval" ? "waiting-approval" : "completed",
      runId,
      payload: {
        status,
        error: error || undefined,
        approvalIds: approvalIds.length > 0 ? approvalIds : undefined,
      },
      at,
    });
    if (session.activeRunId === runId) {
      session.activeRunId = null;
    }
    session.status = status;
    session.updatedAt = at;
    session.lastRunCompletedAt = at;
    data.sessions[index] = session;
    this.write(data);
    return this.summarizeSession(session);
  }

  archiveSessionInData(data, sessionId, reason) {
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    if (session.activeRunId || session.queueDepth > 0) {
      throw new Error("Cannot reset a session while a run is active or queued.");
    }

    const at = new Date().toISOString();
    session.lifecycleState = "archived";
    session.status = "archived";
    session.endedAt = at;
    session.updatedAt = at;
    session.resetReason = reason;
    this.appendTranscriptEntryInData(session, {
      type: "event",
      event: "session.archived",
      payload: { reason },
      at,
    });
    data.sessions[index] = session;
    return session;
  }

  archiveSession(sessionId, reason = "manual-reset") {
    const data = this.read();
    const session = this.archiveSessionInData(data, sessionId, reason);
    this.write(data);
    return this.summarizeSession(session);
  }

  updateSession(sessionId, updates) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    data.sessions[index] = this.normalizeSession({
      ...data.sessions[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    this.write(data);
    return this.summarizeSession(data.sessions[index]);
  }

  updateQueueState(sessionId, queuedRunIds = []) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    const normalizedQueuedRunIds = queuedRunIds.map(String);
    session.queuedRunIds = normalizedQueuedRunIds;
    session.queueDepth = normalizedQueuedRunIds.length;
    if (!session.activeRunId && session.lifecycleState !== "archived") {
      if (session.queueDepth > 0) {
        session.status = "queued";
      } else if (session.status === "queued") {
        session.status = "idle";
      }
    }
    session.updatedAt = new Date().toISOString();
    data.sessions[index] = session;
    this.write(data);
    return this.summarizeSession(session);
  }

  readTranscriptEntries(session, limit = 0) {
    const transcriptPath = this.getTranscriptAbsolutePath(session);
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }

    const lines = fs
      .readFileSync(transcriptPath, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const entries = lines
      .map((line) => safeJsonParse(line, null))
      .filter(Boolean);

    if (limit > 0) {
      return entries.slice(-limit);
    }
    return entries;
  }

  getSession(sessionId, options = {}) {
    const data = this.read();
    const session = this.findSession(data, sessionId);
    if (!session) {
      return null;
    }

    const messageLimit = Number(options.messageLimit || this.getSettings().detailMessageLimit);
    const transcript = this.readTranscriptEntries(session, messageLimit);
    return {
      ...this.summarizeSession(session),
      transcript,
      transcriptEntryCount: transcript.length,
    };
  }
}
