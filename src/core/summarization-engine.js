import fs from "node:fs";
import path from "node:path";

export class SummarizationEngine {
  constructor(rootDir, provider, gatewayStore = null) {
    this.rootDir = rootDir;
    this.provider = provider;
    this.gatewayStore = gatewayStore;
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

  async summarizeSession(session, transcriptEntries) {
    if (!transcriptEntries || transcriptEntries.length === 0) {
      return null;
    }

    const sessionId = session.id;
    const existing = this.readSummary(sessionId);
    
    // Threshold for re-summarization: e.g., every 10 new messages
    const currentMessageCount = transcriptEntries.filter(e => e.type === "message").length;
    if (existing && currentMessageCount - (existing.messageCountAtLastSummary || 0) < 10) {
      return existing;
    }

    if (this.gatewayStore) {
      this.gatewayStore.addEvent("session.summarization_started", { sessionId });
    }

    const conversationText = transcriptEntries
      .filter(e => e.type === "message")
      .map(e => `${e.role.toUpperCase()}: ${e.text}`)
      .join("\n\n");

    const prompt = `Summarize the following conversation in a very concise way. 
Focus on:
1. Key user intents and requests.
2. Important facts or preferences shared by the user.
3. Status of ongoing tasks.
4. Key decisions made.

Keep the summary under 1000 characters.

Conversation:
${conversationText}`;

    try {
      const response = await this.provider.complete([
        { role: "system", content: "You are a concise summarization assistant." },
        { role: "user", content: prompt }
      ]);

      const summary = response.text || "";
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
