import fs from "node:fs";
import path from "node:path";

export class SummarizationEngine {
  constructor(rootDir, provider, gatewayStore = null, configStore = null) {
    this.rootDir = rootDir;
    this.provider = provider;
    this.gatewayStore = gatewayStore;
    this.configStore = configStore;
    this.summaryDir = path.join(rootDir, "data", "sessions", "summaries");
    fs.mkdirSync(this.summaryDir, { recursive: true });
  }

  getSummaryPath(sessionId) {
    return path.join(this.summaryDir, `${sessionId}.json`);
  }

  readSummary(sessionId) {
    const filePath = this.getSummaryPath(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  writeSummary(sessionId, summaryData) {
    const filePath = this.getSummaryPath(sessionId);
    fs.writeFileSync(filePath, JSON.stringify(summaryData, null, 2));
  }

  async summarizeSession(session, transcriptEntries, options = {}) {
    if (!transcriptEntries || transcriptEntries.length === 0) {
      return null;
    }

    const sessionId = session.id;
    const force = Boolean(options.force);
    const existing = this.readSummary(sessionId);
    
    // Threshold for re-summarization: keep it fresh (every 4 new messages) so a
    // mid-task "continue" reflects recently built files instead of going stale.
    // force=1 (on-demand UI) bypasses the threshold so the user always gets a summary.
    const currentMessageCount = transcriptEntries.filter(e => e.type === "message").length;
    if (!force && existing && currentMessageCount - (existing.messageCountAtLastSummary || 0) < 4) {
      return existing;
    }

    if (this.gatewayStore) {
      this.gatewayStore.addEvent("session.summarization_started", { sessionId });
    }

    // Bound the input: keep the newest turns (they carry the current state)
    // and cap per-message size so one giant paste can't blow the request.
    const conversationText = transcriptEntries
      .filter(e => e.type === "message")
      .map(e => `${e.role.toUpperCase()}: ${String(e.text || "").slice(0, 5000)}`)
      .join("\n\n")
      .slice(-80000);

    // Structured, machine-parsable-ish sections: the next session's model (often
    // a weak one) resumes far better from labeled facts than from prose.
    const prompt = `Update the persistent work summary for this AI agent session. Output a DENSE factual summary the agent will rely on in FUTURE sessions. Use exactly these labeled sections, omitting any that are empty:
GOAL: what the user is trying to get done overall (1 line)
DONE: concrete work completed — files created/edited WITH paths, commands run and their results
DECISIONS: non-obvious choices made and why (1 line each)
STATE: current state — what is verified working vs unverified/broken
NEXT: the immediate next step if work continues
PREFS: durable user preferences/facts revealed (language, style, constraints)

Keep it under 1800 characters. No preamble, no pleasantries.

Conversation:
${conversationText}`;

    try {
      // Offload to the cheaper compaction model when configured — summaries run
      // on every few messages and don't need the primary model.
      const compactionModel = this.configStore?.getConfig?.()?.provider?.compactionModel || "";
      const response = await this.provider.complete([
        { role: "system", content: "You compress an AI agent's session into a structured factual work summary for its own future reference." },
        { role: "user", content: prompt }
      ], { maxTokens: 1500, timeoutMs: 45000, ...(compactionModel ? { model: compactionModel } : {}) });

      const summary = String(response.text || "").trim();
      // Quality gate: a hiccuping compaction model (empty response, a refusal,
      // or a tiny fragment) must NOT overwrite an accumulated good summary —
      // that silently wipes the session continuity the next resume depends on.
      // Require a non-trivial length AND at least one of the structured section
      // labels the prompt demanded; otherwise keep the prior summary and retry
      // next cycle (messageCountAtLastSummary stays put, so it isn't skipped).
      const looksStructured = /\b(GOAL|DONE|DECISIONS|STATE|NEXT|PREFS)\b/.test(summary);
      if (summary.length < 40 || !looksStructured) {
        if (this.gatewayStore) {
          this.gatewayStore.addEvent("session.summarization_rejected", {
            sessionId,
            summaryLength: summary.length,
            structured: looksStructured,
            reason: summary.length < 40 ? "too-short-or-empty" : "no-structured-sections",
          });
        }
        return existing; // keep the last good summary; do not overwrite with garbage
      }
      const summaryData = {
        sessionId,
        text: summary,
        messageCountAtLastSummary: currentMessageCount,
        updatedAt: new Date().toISOString(),
      };

      this.writeSummary(sessionId, summaryData);

      if (this.gatewayStore) {
        this.gatewayStore.addEvent("session.summarization_completed", {
          sessionId,
          summaryLength: summary.length
        });
      }

      return summaryData;
    } catch (error) {
      if (this.gatewayStore) {
        this.gatewayStore.addEvent("session.summarization_failed", { 
          sessionId, 
          error: error.message 
        });
      }
      return existing; // Return old summary if new one fails
    }
  }
}
