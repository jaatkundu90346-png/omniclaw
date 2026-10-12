import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, withFileLock } from "./atomic-write.js";

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
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function sortByUpdatedAtDesc(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
  const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
  return rightTime - leftTime;
}

function normalizeRouteValue(value) {
  const text = String(value == null ? "" : value).trim();
  return text || null;
}

// Cross-turn evidence ledger shape (see agent.buildEvidenceLedger):
// { turn, files: {key: {size, turn, about, mtimeMs, hash}},
//   edits: [{path, turn, what}], commands: [{cmd, exit, turn, result}],
//   findings: [str] }. Validated + capped: corrupt or oversized records
// degrade to null/trimmed instead of breaking session loads.
function normalizeEvidenceLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const files = {};
  const rawFiles = value.files && typeof value.files === "object" ? value.files : {};
  for (const [key, entry] of Object.entries(rawFiles).slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const k = String(key || "").slice(0, 300);
    if (!k) continue;
    files[k] = {
      size: Math.max(0, Number(entry.size || 0) || 0),
      turn: Math.max(0, Number(entry.turn || 0) || 0),
      about: String(entry.about || "").slice(0, 140),
      // Full content for small files (<=2000 chars) so the ledger inlines
      // it; legacy `head` entries migrate forward untouched.
      content: String(entry.content ?? entry.head ?? "").slice(0, 2000),
      head: String(entry.head || "").slice(0, 850),
      mtimeMs: Number(entry.mtimeMs || 0) || 0,
      hash: String(entry.hash || "").slice(0, 64),
    };
  }
  const list = (arr, map, cap) => (Array.isArray(arr) ? arr : []).slice(-cap).map(map);
  return {
    turn: Math.max(0, Number(value.turn || 0) || 0),
    files,
    edits: list(value.edits, (e) => ({
      path: String(e?.path || "").slice(0, 300),
      turn: Math.max(0, Number(e?.turn || 0) || 0),
      what: String(e?.what || "").slice(0, 140),
    }), 10),
    commands: list(value.commands, (c) => ({
      cmd: String(c?.cmd || "").slice(0, 160),
      exit: c?.exit ?? null,
      turn: Math.max(0, Number(c?.turn || 0) || 0),
      result: String(c?.result || "").slice(0, 140),
    }), 10),
    findings: list(value.findings, (f) => String(f || "").slice(0, 160), 5),
  };
}

function normalizeIdentityToken(channel, peerId) {
  const rawPeer = String(peerId || "").trim().toLowerCase();
  const rawChannel = String(channel || "").trim().toLowerCase();
  if (!rawPeer) return "";
  return rawPeer.includes(":") ? rawPeer : `${rawChannel}:${rawPeer}`;
}

function findIdentityGroup(identityLinks = {}, token = "") {
  const wanted = String(token || "").trim().toLowerCase();
  if (!wanted || !identityLinks || typeof identityLinks !== "object") {
    return null;
  }
  for (const [group, ids] of Object.entries(identityLinks)) {
    if (!Array.isArray(ids)) continue;
    const normalized = ids.map((id) => String(id || "").trim().toLowerCase());
    if (normalized.includes(wanted)) {
      return { group, ids: normalized };
    }
  }
  return null;
}

export class SessionStore {
  constructor(rootDir, configStore = null) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    // Folder-scoped chat history: the agent updates this on workspace switch.
    this.workspaceId = "default";
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

  // Atomic: sessions.json used to be written with a bare fs.writeFileSync, so a
  // kill/power-loss mid-write truncated the WHOLE store and every later read fell
  // back to an empty one (safeJsonParse swallows it) — i.e. the chat history of
  // every session silently disappeared. Temp + rename makes the swap
  // all-or-nothing. Same pattern as memory-store.js write(). See atomic-write.js.
  // Format is unchanged: {version, sessions}.
  write(data) {
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  // Serialized read -> mutate -> write. The synchronous mutators in this class
  // (appendMessage, resolveSession, persistSession, …) cannot interleave because
  // Node runs each one to completion, but ANY caller that awaits between its read
  // and its write can lose another caller's write (last writer wins). Route those
  // through this and the per-path promise chain in atomic-write.js serializes
  // them. `mutator` receives the freshly read store and may mutate it in place;
  // whatever it returns is handed back to the caller.
  //
  // It does NOT touch the transcript JSONL: appendTranscriptEntryInData stays a
  // plain append (a partial trailing line is survivable there, a truncated
  // sessions.json is not).
  mutate(mutator) {
    return withFileLock(this.filePath, () => {
      const data = this.read();
      const result = mutator(data);
      this.write(data);
      return result;
    });
  }

  // Async variants of the two hot write paths, serialized through mutate().
  // Callers that can run concurrently (e.g. several agent runs appending to the
  // same store) must use these; the sync originals stay for every existing
  // caller so no signature changes ripple.
  async createSessionInStore(options) {
    const session = this.createSession(options);
    await this.mutate((data) => {
      if (!data.sessions.some((item) => item.id === session.id)) {
        data.sessions.push(this.normalizeSession(session));
      }
      return session;
    });
    return this.summarizeSession(session);
  }

  async appendMessageInStore(sessionId, message) {
    return this.mutate((data) => {
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
        runId: message.runId || undefined,
        toolOutputs: Array.isArray(message.toolOutputs) ? message.toolOutputs : undefined,
        modelToolLoop: message.modelToolLoop && typeof message.modelToolLoop === "object" ? message.modelToolLoop : undefined,
        providerDiagnostics:
          message.providerDiagnostics && typeof message.providerDiagnostics === "object" ? message.providerDiagnostics : undefined,
        finalMetadata:
          message.finalMetadata && typeof message.finalMetadata === "object" ? message.finalMetadata : undefined,
        planSummary: message.planSummary || undefined,
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
      return this.summarizeSession(session);
    });
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
      lastChannel: normalizeRouteValue(session.lastChannel),
      lastTo: normalizeRouteValue(session.lastTo),
      lastAccountId: normalizeRouteValue(session.lastAccountId),
      deliveryContext:
        session.deliveryContext && typeof session.deliveryContext === "object"
          ? {
              channel: normalizeRouteValue(session.deliveryContext.channel),
              to: normalizeRouteValue(session.deliveryContext.to),
              accountId: normalizeRouteValue(session.deliveryContext.accountId),
            }
          : null,
      lastUserMessagePreview: String(session.lastUserMessagePreview || ""),
      lastAssistantPreview: String(session.lastAssistantPreview || ""),
      transcriptPath,
      // B1 step 6 (additive, default null): workspace path persists in meta so
      // it survives recents pruning; legacy sessions carry no path → null.
      workspacePath: session.workspacePath || null,
      model: session.model || null,
      // T2.2 (additive, default []): pinned toolset names for the menu builder.
      pinnedToolsets: Array.isArray(session.pinnedToolsets) ? session.pinnedToolsets.map(String) : [],
      // Cross-turn evidence ledger (additive, default null): per-session
      // compact record of files read/edited + commands run, so follow-up
      // turns don't re-read unchanged files. Validated + size-capped here so
      // a corrupt record can never break session loads.
      evidenceLedger: normalizeEvidenceLedger(session.evidenceLedger),
    };
  }

  getEvidenceLedger(sessionId) {
    try {
      const data = this.read();
      const session = this.findSession(data, String(sessionId || "").trim());
      if (!session) return null;
      return normalizeEvidenceLedger(session.evidenceLedger);
    } catch {
      return null;
    }
  }

  // Workspace id parsed from the session-key suffix (agent:...:ws:<id>).
  // Legacy pre-scoping keys have no suffix → null.
  workspaceIdForKey(key) {
    const m = String(key || "").match(/:ws:([^:]+)$/);
    return m ? m[1] : null;
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

  // Chat history is scoped per workspace folder: switching folders gives you a
  // different session, so each project keeps its own conversation. Called by
  // the agent whenever the user picks a different folder.
  setWorkspaceId(workspaceId) {
    const next = String(workspaceId || "").trim() || "default";
    if (next === this.workspaceId) return this.workspaceId;
    this.workspaceId = next;
    return this.workspaceId;
  }

  buildSessionKey({ label = "main", agentId = "main", channel = "webchat", workspaceId = null } = {}) {
    const scope = String(workspaceId || this.workspaceId || "default").trim() || "default";
    return `agent:${agentId}:${channel}:${label}:ws:${scope}`;
  }

  // Pre-workspace-feature sessions used this shape. Kept so existing chat
  // history isn't orphaned when the app upgrades.
  buildLegacySessionKey({ label = "main", agentId = "main", channel = "webchat" } = {}) {
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
      lastChannel: session.lastChannel,
      lastTo: session.lastTo,
      lastAccountId: session.lastAccountId,
      deliveryContext: session.deliveryContext,
      transcriptPath: session.transcriptPath,
      lastUserMessagePreview: session.lastUserMessagePreview,
      lastAssistantPreview: session.lastAssistantPreview,
      // B1 step 6 (additive): legacy sessions report workspacePath:null.
      workspacePath: session.workspacePath || null,
      workspaceId: this.workspaceIdForKey(session.key),
      model: session.model || null,
      // T2.2 (additive): per-session pinned toolsets (composer + Tools pin).
      pinnedToolsets: Array.isArray(session.pinnedToolsets) ? session.pinnedToolsets.map(String) : [],
      idleMinutes,
      stale,
    };
  }

  listSessions(limit = 50) {
    const sessions = [...this.read().sessions].sort(sortByUpdatedAtDesc).slice(0, limit);
    return sessions.map((session) => this.summarizeSession(session));
  }

  listSessionSummariesFast(limit = 50) {
    const max = Math.max(1, Math.min(200, Number(limit || 50)));
    const parsed = this.readRaw();
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return sessions
      .map((session) => this.normalizeSession(session))
      .sort(sortByUpdatedAtDesc)
      .slice(0, max)
      .map((session) => this.summarizeSession(session));
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

  createSession({ key, label, agentId, channel, parentSessionId = null, resetReason = null, workspacePath = null, model = null }) {
    const now = new Date().toISOString();
    const session = this.normalizeSession({
      id: createId("session"),
      key,
      label,
      agentId,
      channel,
      workspacePath,
      model,
      status: "idle",
      lifecycleState: "active",
      createdAt: now,
      updatedAt: now,
      queueDepth: 0,
      queuedRunIds: [],
      parentSessionId,
      resetReason,
      lastChannel: channel || null,
      lastTo: null,
      lastAccountId: null,
      deliveryContext: null,
    });
    this.ensureTranscriptArtifacts(session, { overwrite: true });
    return session;
  }

  // Persist an in-memory session built by createSession (the import route's
  // path — resolveSession persists via its own write, createSession does not).
  persistSession(session) {
    if (!session || !session.id) throw new Error("session is required.");
    const data = this.read();
    if (!data.sessions.some((s) => s.id === session.id)) {
      data.sessions.push(this.normalizeSession(session));
    }
    this.write(data);
    return this.summarizeSession(this.findSession(data, session.id));
  }

  resolveSession({ sessionId = "", label = "main", agentId = "main", channel = "webchat", parentSessionId = null, workspacePath = null, model = null } = {}) {
    const data = this.read();
    let changed = false;
    let resolved = null;
    const requestedId = String(sessionId || "").trim();

    if (requestedId) {
      resolved = this.findSession(data, requestedId);
    } else {
      const key = this.buildSessionKey({ label, agentId, channel });
      let matchingSessions = data.sessions.filter((session) => session.key === key).sort(sortByUpdatedAtDesc);
      let activeSessions = matchingSessions
        .filter((session) => session.lifecycleState !== "archived")
        .sort(sortByUpdatedAtDesc);

      // Migration: sessions created before folder-scoping existed carry the
      // legacy key. Adopt them into the default workspace so nobody loses
      // their chat history on upgrade.
      if (activeSessions.length === 0 && this.workspaceId === "default") {
        const legacyKey = this.buildLegacySessionKey({ label, agentId, channel });
        const legacy = data.sessions
          .filter((session) => session.key === legacyKey && session.lifecycleState !== "archived")
          .sort(sortByUpdatedAtDesc);
        if (legacy.length > 0) {
          legacy[0].key = key;
          legacy[0].workspaceId = this.workspaceId;
          changed = true;
          matchingSessions = legacy;
          activeSessions = legacy;
        }
      }

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
          workspacePath,
          model,
        });
        data.sessions.push(resolved);
        changed = true;
      }
    }

    if (!resolved) {
      return null;
    }

    // Per-chat bind: workspace path is set on create (or backfilled once when
    // the record has none). Never overwrite a stored path just because the
    // global selection moved on — opening an old chat must not restamp it.
    if (workspacePath && !resolved.workspacePath) {
      resolved.workspacePath = workspacePath;
      changed = true;
    }
    if (model && resolved.model !== model) {
      resolved.model = model;
      changed = true;
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
      runId: message.runId || undefined,
      toolOutputs: Array.isArray(message.toolOutputs) ? message.toolOutputs : undefined,
      modelToolLoop: message.modelToolLoop && typeof message.modelToolLoop === "object" ? message.modelToolLoop : undefined,
      providerDiagnostics:
        message.providerDiagnostics && typeof message.providerDiagnostics === "object" ? message.providerDiagnostics : undefined,
      finalMetadata:
        message.finalMetadata && typeof message.finalMetadata === "object" ? message.finalMetadata : undefined,
      planSummary: message.planSummary || undefined,
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
    session.archiveReason = reason;
    session.archivedAt = at;
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

  // Changes only the display label. The routing key stays untouched so
  // channel/label continuation keeps resolving to this session.
  renameSession(sessionId, label) {
    const nextLabel = String(label || "").trim().slice(0, 80);
    if (!nextLabel) {
      throw new Error("label is required");
    }
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    data.sessions[index].label = nextLabel;
    data.sessions[index].updatedAt = new Date().toISOString();
    this.write(data);
    return this.summarizeSession(data.sessions[index]);
  }

  cleanupProblemSessions(options = {}) {
    const data = this.read();
    const reason = String(options.reason || "cleanup-problem-history").trim();
    const includeArchived = Boolean(options.includeArchived);
    const patterns = (Array.isArray(options.patterns) && options.patterns.length > 0
      // Caller-supplied patterns (e.g. from the HTTP API) are bounded — cap the
      // count and per-pattern length so an attacker can't submit a catastrophic
      // regex that hangs the event loop (ReDoS). The haystack is capped below too.
      ? options.patterns.slice(0, 20).map((p) => String(p || "")).filter((p) => p.length > 0 && p.length <= 200)
      : [
          "\\bAli\\b[\\s\\S]{0,160}\\bKarachi\\b",
          "\\bKarachi\\b[\\s\\S]{0,160}\\bAli\\b",
          "\\bClaw\\b[\\s\\S]{0,160}\\bAli\\b",
          "\\bAli\\b[\\s\\S]{0,160}\\bClaw\\b",
          "\\bSmokeUser\\w*\\b",
          "\\bRequest timed out\\b",
          "\\bRun timed out after\\b",
          "\\bprovider took too long\\b",
          "\\bno API key is available\\b",
          "\\bbuilt-in mock provider\\b",
          "\\bHui\\b[\\s\\S]{0,220}\\bOpenClaw\\b",
          "\\bOpenClaw\\b[\\s\\S]{0,220}\\bHui\\b",
          "\\bmock/local-rule-engine\\b",
          "\\bmy name is indeed Claw\\b",
          "\\bNamaste! Mera naam OmniClaw hai\\b",
        ])
      .map((pattern) => {
        try {
          return new RegExp(pattern, "i");
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const archived = [];
    const skipped = [];
    for (const session of data.sessions) {
      if (!includeArchived && session.lifecycleState === "archived") {
        skipped.push({ id: session.id, reason: "already archived" });
        continue;
      }
      if (session.activeRunId || session.queueDepth > 0) {
        skipped.push({ id: session.id, reason: "active or queued" });
        continue;
      }
      const transcript = this.readTranscriptEntries(session, 0);
      const haystack = [
        session.label,
        session.lastUserMessagePreview,
        session.lastAssistantPreview,
        ...transcript.map((entry) => `${entry.role || entry.event || ""} ${entry.text || ""} ${JSON.stringify(entry.payload || {})}`),
      ].join("\n").slice(0, 65536); // bound regex input length (ReDoS defense)
      const matched = patterns.find((pattern) => pattern.test(haystack));
      if (!matched) {
        continue;
      }
      this.archiveSessionInData(data, session.id, reason);
      archived.push({
        id: session.id,
        label: session.label,
        matched: String(matched),
      });
    }

    this.write(data);
    return {
      archivedCount: archived.length,
      skippedCount: skipped.length,
      archived,
      skipped,
      reason,
    };
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

  dockSession(sessionId, route = {}) {
    const data = this.read();
    const index = this.findSessionIndex(data, sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = data.sessions[index];
    const targetChannel = normalizeRouteValue(route.channel || route.targetChannel);
    const targetTo = normalizeRouteValue(route.to || route.targetTo || route.peerId || route.targetPeerId);
    const targetAccountId = normalizeRouteValue(route.accountId || route.targetAccountId || "default");
    const sourceChannel = normalizeRouteValue(route.sourceChannel || session.lastChannel || session.channel);
    const sourceTo = normalizeRouteValue(route.sourceTo || route.sourcePeerId || route.from || session.lastTo);

    if (!targetChannel || !targetTo) {
      return {
        ok: false,
        blocked: true,
        reason: "missing-target-route",
        message: "Docking requires target channel and target peer/to id.",
        session: this.summarizeSession(session),
      };
    }

    const identityLinks = this.configStore?.getConfig?.()?.session?.identityLinks || {};
    if (Object.keys(identityLinks).length > 0) {
      const targetToken = normalizeIdentityToken(targetChannel, targetTo);
      const targetGroup = findIdentityGroup(identityLinks, targetToken);
      if (!targetGroup) {
        return {
          ok: false,
          blocked: true,
          reason: "target-not-linked",
          message: `Target ${targetToken} is not present in session.identityLinks.`,
          session: this.summarizeSession(session),
        };
      }
      if (sourceTo) {
        const sourceToken = normalizeIdentityToken(sourceChannel || session.channel, sourceTo);
        const sourceGroup = findIdentityGroup(identityLinks, sourceToken);
        if (!sourceGroup || sourceGroup.group !== targetGroup.group) {
          return {
            ok: false,
            blocked: true,
            reason: "source-target-not-linked",
            message: `Source ${sourceToken} and target ${targetToken} are not in the same identityLinks group.`,
            session: this.summarizeSession(session),
          };
        }
      }
    }

    const at = new Date().toISOString();
    session.lastChannel = targetChannel;
    session.lastTo = targetTo;
    session.lastAccountId = targetAccountId;
    session.deliveryContext = {
      channel: targetChannel,
      to: targetTo,
      accountId: targetAccountId,
    };
    session.updatedAt = at;
    this.appendTranscriptEntryInData(session, {
      type: "event",
      event: "session.docked",
      payload: {
        sourceChannel,
        sourceTo,
        targetChannel,
        targetTo,
        targetAccountId,
      },
      at,
    });
    data.sessions[index] = this.normalizeSession(session);
    this.write(data);
    return {
      ok: true,
      docked: true,
      route: {
        channel: targetChannel,
        to: targetTo,
        accountId: targetAccountId,
      },
      session: this.summarizeSession(data.sessions[index]),
    };
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

  // ─── Session Compaction ───────────────────────────────────────
  getSessionSize(sessionId) {
    const data = this.read();
    const session = this.findSession(data, sessionId);
    if (!session) return 0;
    return this.readTranscriptEntries(session).length;
  }

  compactSession(sessionId, maxEntries = 80) {
    const data = this.read();
    const session = this.findSession(data, sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const entries = this.readTranscriptEntries(session);
    if (entries.length <= maxEntries) return { compacted: false, totalEntries: entries.length };
    const keepCount = Math.floor(maxEntries * 0.6);
    const kept = entries.slice(-keepCount);
    const removed = entries.slice(0, entries.length - keepCount);
    const summary = removed
      .filter(e => e.type === "message")
      .map(e => `${e.role}: ${String(e.text || "").slice(0, 100)}`)
      .join("\n");
    const compactionEntry = {
      type: "compaction",
      sessionId,
      at: new Date().toISOString(),
      removedCount: removed.length,
      summary: summary.slice(0, 2000),
    };
    const transcriptPath = this.getTranscriptAbsolutePath(session);
    const lines = [JSON.stringify(compactionEntry), ...kept.map(e => JSON.stringify(e))];
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");
    const index = this.findSessionIndex(data, sessionId);
    data.sessions[index].messageCount = kept.filter(e => e.type === "message").length;
    data.sessions[index].updatedAt = new Date().toISOString();
    this.write(data);
    return { compacted: true, removedCount: removed.length, keptCount: kept.length };
  }

  // ─── Session Rotation with Handoff ─────────────────────────────────

  /**
   * Read handoff file content and parse it into sections.
   * @param {string} handoffPath - Path to handoff markdown file
   * @returns {Object} Parsed handoff content
   */
  readHandoffFile(handoffPath) {
    if (!fs.existsSync(handoffPath)) {
      throw new Error(`Handoff file not found: ${handoffPath}`);
    }
    const content = fs.readFileSync(handoffPath, "utf-8");
    const sections = this.parseHandoffContent(content);
    return { path: handoffPath, content, sections };
  }

  /**
   * Parse handoff markdown content into structured sections.
   * @param {string} content - Markdown content
   * @returns {Object} Parsed sections
   */
  parseHandoffContent(content) {
    const result = {
      goal: "",
      progress: "",
      modifiedFiles: [],
      keyDecisions: [],
      openQuestions: [],
      nextSteps: "",
    };

    const lines = content.split(/\r?\n/);
    let currentSection = null;
    let listBuffer = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Section headers
      if (/^#+\s*(goal|target|objective)/i.test(trimmed)) {
        currentSection = "goal";
      } else if (/^#+\s*progress|done|completed/i.test(trimmed)) {
        currentSection = "progress";
      } else if (/^#+\s*(modified|changed|files?)/i.test(trimmed)) {
        currentSection = "modifiedFiles";
      } else if (/^#+\s*(key|important)\s*(decision|choice)/i.test(trimmed)) {
        currentSection = "keyDecisions";
      } else if (/^#+\s*(open|remaining)\s*(question|issue)/i.test(trimmed)) {
        currentSection = "openQuestions";
      } else if (/^#+\s*(next|what['"']?s?\s*next|action)/i.test(trimmed)) {
        currentSection = "nextSteps";
      } else if (currentSection && (trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed))) {
        // List items
        listBuffer.push(trimmed.replace(/^[-*\d.]\s*/, "").trim());
      } else if (currentSection && trimmed) {
        // Paragraph content
        if (currentSection === "goal" || currentSection === "progress" || currentSection === "nextSteps") {
          result[currentSection] += (result[currentSection] ? " " : "") + trimmed;
        }
      }
    }

    // Flush list buffer to appropriate section
    if (listBuffer.length > 0) {
      if (currentSection === "modifiedFiles") {
        result.modifiedFiles = listBuffer;
      } else if (currentSection === "keyDecisions") {
        result.keyDecisions = listBuffer;
      } else if (currentSection === "openQuestions") {
        result.openQuestions = listBuffer;
      }
    }

    return result;
  }

  /**
   * Rotate session with handoff - archive old, create new with context.
   * @param {string} sessionId - Session to rotate
   * @param {string} handoffPath - Path to handoff markdown file
   * @param {Object} options - Rotation options
   * @returns {Object} New session info
   */
  rotateSession(sessionId, handoffPath, options = {}) {
    const data = this.read();
    const oldSession = this.findSession(data, sessionId);
    if (!oldSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Read and parse handoff
    const handoff = this.readHandoffFile(handoffPath);

    // Archive old session
    this.archiveSessionInData(data, sessionId, `rotated:${handoffPath}`);

    // Create new session maintaining lineage
    const newSession = this.createSession({
      key: oldSession.key,
      label: oldSession.label,
      agentId: oldSession.agentId,
      channel: oldSession.channel,
      parentSessionId: sessionId, // Link to old session
      resetReason: "session_rotation",
    });

    // Inject handoff content as first message
    const handoffMessage = {
      type: "handoff",
      sessionId: newSession.id,
      parentSessionId: sessionId,
      at: new Date().toISOString(),
      ...handoff.sections,
      fullContent: handoff.content,
    };

    const transcriptPath = this.getTranscriptAbsolutePath(newSession);
    fs.appendFileSync(transcriptPath, JSON.stringify(handoffMessage) + "\n");

    // Update data store
    data.sessions.push(newSession);
    this.write(data);

    return {
      oldSessionId: sessionId,
      newSessionId: newSession.id,
      handoffPath: handoffPath,
      handoffSections: handoff.sections,
      lineage: {
        parent: sessionId,
        child: newSession.id,
      },
    };
  }

  /**
   * Get session lineage (parent chain).
   * @param {string} sessionId - Starting session
   * @returns {Array} Array of session IDs in lineage
   */
  getSessionLineage(sessionId) {
    const data = this.read();
    const lineage = [sessionId];
    let currentId = sessionId;

    while (true) {
      const session = this.findSession(data, currentId);
      if (!session || !session.parentSessionId) break;
      lineage.push(session.parentSessionId);
      currentId = session.parentSessionId;
      if (lineage.length > 100) break; // Safety limit
    }

    return lineage.reverse();
  }

}
