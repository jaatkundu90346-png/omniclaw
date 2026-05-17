import fs from "node:fs";
import path from "node:path";

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class SessionLifecycle {
  constructor({ rootDir, sessionStore, configStore }) {
    this.rootDir = rootDir;
    this.sessionStore = sessionStore;
    this.configStore = configStore;
    this.transcriptsDir = path.join(rootDir, "data", "sessions", "transcripts");
    this.archiveDir = path.join(rootDir, "data", "sessions", "archive");
    fs.mkdirSync(this.transcriptsDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
  }

  getTranscriptPath(sessionId) {
    return path.join(this.transcriptsDir, `${sessionId}.jsonl`);
  }

  getArchivePath(sessionId) {
    return path.join(this.archiveDir, `${sessionId}.jsonl.gz`);
  }

  appendTranscript(sessionId, entry) {
    const filePath = this.getTranscriptPath(sessionId);
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(filePath, line, "utf8");
  }

  readTranscript(sessionId, maxLines = 1000) {
    const filePath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-maxLines).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  getTranscriptStats(sessionId) {
    const filePath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(filePath)) return { exists: false, lines: 0, bytes: 0, tokens: 0 };
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const totalChars = lines.reduce((sum, line) => sum + line.length, 0);
    return {
      exists: true,
      lines: lines.length,
      bytes: stat.size,
      tokens: estimateTokens(content),
      chars: totalChars,
      lastModified: stat.mtime.toISOString(),
    };
  }

  async compactSession(sessionId, maxMessages = 80, keepFirst = 5, keepLast = 10) {
    const transcript = this.readTranscript(sessionId);
    if (transcript.length <= maxMessages) {
      return { compacted: false, reason: "Below threshold", originalCount: transcript.length };
    }

    const first = transcript.slice(0, keepFirst);
    const last = transcript.slice(-keepLast);

    const middle = transcript.slice(keepFirst, -keepLast);
    const summary = this.summarizeMessages(middle);

    const summaryEntry = {
      type: "summary",
      role: "system",
      content: summary,
      timestamp: new Date().toISOString(),
      originalMessageCount: middle.length,
    };

    const compacted = [...first, summaryEntry, ...last];
    const filePath = this.getTranscriptPath(sessionId);
    const content = compacted.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");

    return {
      compacted: true,
      originalCount: transcript.length,
      newCount: compacted.length,
      removedCount: transcript.length - compacted.length,
      summaryLength: summary.length,
      summaryTokens: estimateTokens(summary),
    };
  }

  summarizeMessages(messages) {
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    const topics = new Set();
    for (const msg of userMessages) {
      const content = String(msg.content || "").slice(0, 100);
      if (content.length > 10) topics.add(content);
    }

    const toolCalls = messages.filter((m) => m.tool_calls || m.tool_call_id);

    let summary = `[${messages.length} messages summarized] `;
    summary += `User asked about: ${Array.from(topics).slice(0, 5).join("; ")}. `;
    summary += `Assistant responded with ${assistantMessages.length} messages. `;
    if (toolCalls.length > 0) {
      summary += `${toolCalls.length} tool calls were executed. `;
    }

    return summary;
  }

  async archiveSession(sessionId) {
    const transcriptPath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(transcriptPath)) {
      return { archived: false, reason: "Transcript not found" };
    }

    const content = fs.readFileSync(transcriptPath, "utf8");
    const archivePath = this.getArchivePath(sessionId);

    const zlib = await import("node:zlib");
    const compressed = zlib.gzipSync(Buffer.from(content, "utf8"));
    fs.writeFileSync(archivePath, compressed);

    fs.unlinkSync(transcriptPath);

    if (this.sessionStore) {
      try {
        this.sessionStore.updateSessionLifecycle?.(sessionId, "archived");
      } catch {}
    }

    return {
      archived: true,
      sessionId,
      archivePath,
      compressedBytes: compressed.length,
      originalBytes: content.length,
      compressionRatio: (compressed.length / content.length).toFixed(2),
      archivedAt: new Date().toISOString(),
    };
  }

  async restoreSession(sessionId) {
    const archivePath = this.getArchivePath(sessionId);
    if (!fs.existsSync(archivePath)) {
      return { restored: false, reason: "Archive not found" };
    }

    const zlib = await import("node:zlib");
    const compressed = fs.readFileSync(archivePath);
    const content = zlib.gunzipSync(compressed).toString("utf8");

    const transcriptPath = this.getTranscriptPath(sessionId);
    fs.writeFileSync(transcriptPath, content, "utf8");

    fs.unlinkSync(archivePath);

    if (this.sessionStore) {
      try {
        this.sessionStore.updateSessionLifecycle?.(sessionId, "active");
      } catch {}
    }

    return {
      restored: true,
      sessionId,
      transcriptPath,
      restoredAt: new Date().toISOString(),
    };
  }

  listArchivedSessions() {
    if (!fs.existsSync(this.archiveDir)) return [];
    const files = fs.readdirSync(this.archiveDir).filter((f) => f.endsWith(".jsonl.gz"));
    return files.map((file) => {
      const sessionId = file.replace(".jsonl.gz", "");
      const stat = fs.statSync(path.join(this.archiveDir, file));
      return {
        sessionId,
        archivePath: path.join(this.archiveDir, file),
        bytes: stat.size,
        archivedAt: stat.mtime.toISOString(),
      };
    });
  }

  cleanupOldSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const cleaned = { archived: 0, deleted: 0 };

    if (fs.existsSync(this.transcriptsDir)) {
      const files = fs.readdirSync(this.transcriptsDir);
      for (const file of files) {
        const filePath = path.join(this.transcriptsDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          try {
            this.archiveSession(file.replace(".jsonl", ""));
            cleaned.archived++;
          } catch {
            fs.unlinkSync(filePath);
            cleaned.deleted++;
          }
        }
      }
    }

    return cleaned;
  }

  getSessionHealth(sessionId) {
    const stats = this.getTranscriptStats(sessionId);
    const config = this.configStore?.getConfig?.() || {};
    const maxTokens = config.tools?.context?.maxTokens || 32000;
    const threshold = config.tools?.context?.compactionThreshold || 0.75;

    return {
      sessionId,
      transcript: stats,
      tokenUsage: stats.tokens,
      tokenBudget: maxTokens,
      utilizationPercent: ((stats.tokens / maxTokens) * 100).toFixed(1),
      needsCompaction: stats.tokens > maxTokens * threshold,
      needsArchival: stats.tokens > maxTokens * 0.9,
    };
  }

  getLifecycleOverview() {
    const activeSessions = this.sessionStore?.listSessions?.(200) || [];
    const archived = this.listArchivedSessions();

    const healthBySession = activeSessions.map((s) => this.getSessionHealth(s.id));
    const needsCompaction = healthBySession.filter((h) => h.needsCompaction);
    const needsArchival = healthBySession.filter((h) => h.needsArchival);

    return {
      activeSessions: activeSessions.length,
      archivedSessions: archived.length,
      totalTranscriptBytes: healthBySession.reduce((sum, h) => sum + (h.transcript.bytes || 0), 0),
      totalTokens: healthBySession.reduce((sum, h) => sum + h.tokenUsage, 0),
      needsCompaction: needsCompaction.length,
      needsArchival: needsArchival.length,
      compactionCandidates: needsCompaction.map((h) => ({
        sessionId: h.sessionId,
        tokens: h.tokenUsage,
        utilizationPercent: h.utilizationPercent,
      })),
    };
  }
}
