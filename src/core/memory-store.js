import fs from "node:fs";
import path from "node:path";

function normalizeAgentId(agentId = "") {
  const value = String(agentId || "").trim();
  return value || "main";
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(value, max = 900) {
  const text = String(value == null ? "" : value).trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 18))}...[truncated]`;
}

function uniqueList(items) {
  return [...new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

export class MemoryStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "data", "memory.json");
    this.markdownPath = path.join(rootDir, "data", "MEMORY.md");
    this.ensureFile();
    this.ensureMarkdownFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            conversations: [],
            notes: [],
            research: [],
            artifacts: [],
            attachmentExtracts: [],
            longTerm: [],
            dreams: [],
          },
          null,
          2,
        ),
      );
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      research: Array.isArray(parsed.research) ? parsed.research : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      attachmentExtracts: Array.isArray(parsed.attachmentExtracts) ? parsed.attachmentExtracts : [],
      longTerm: Array.isArray(parsed.longTerm) ? parsed.longTerm : [],
      dreams: Array.isArray(parsed.dreams) ? parsed.dreams : [],
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  ensureMarkdownFile() {
    fs.mkdirSync(path.dirname(this.markdownPath), { recursive: true });
    if (!fs.existsSync(this.markdownPath)) {
      fs.writeFileSync(
        this.markdownPath,
        [
          "# OmniClaw Memory",
          "",
          "This file is generated from promoted long-term memories.",
          "",
          "## Long-Term Memories",
          "",
          "_No promoted memories yet._",
          "",
        ].join("\n"),
        "utf8",
      );
    }
  }

  syncMarkdown() {
    const data = this.read();
    const items = data.longTerm.slice().sort((left, right) => String(right.promotedAt).localeCompare(String(left.promotedAt)));
    const lines = [
      "# OmniClaw Memory",
      "",
      "This file is generated from promoted long-term memories.",
      "",
      "## Long-Term Memories",
      "",
    ];

    if (items.length === 0) {
      lines.push("_No promoted memories yet._", "");
    } else {
      for (const item of items) {
        lines.push(`### ${item.title || item.id}`);
        lines.push("");
        lines.push(`- Agent: ${item.agentId || "main"}`);
        lines.push(`- Importance: ${item.importance || "medium"}`);
        lines.push(`- Source: ${item.sourceRef || item.sourceType || "manual"}`);
        lines.push(`- Promoted: ${item.promotedAt || item.createdAt || ""}`);
        if (Array.isArray(item.tags) && item.tags.length > 0) {
          lines.push(`- Tags: ${item.tags.join(", ")}`);
        }
        lines.push("");
        lines.push(item.text || "");
        lines.push("");
      }
    }

    fs.writeFileSync(this.markdownPath, lines.join("\n"), "utf8");
    return {
      path: this.markdownPath,
      memoryCount: items.length,
    };
  }

  filterByAgent(items, agentId = "") {
    if (!agentId) {
      return items;
    }

    const normalized = normalizeAgentId(agentId);
    return items.filter((item) => normalizeAgentId(item.agentId) === normalized);
  }

  appendConversation(entry) {
    const data = this.read();
    data.conversations.push({
      agentId: normalizeAgentId(entry.agentId),
      ...entry,
    });
    this.write(data);
    return data;
  }

  addNote(text, options = {}) {
    const data = this.read();
    data.notes.push({
      id: `note_${Date.now()}`,
      text,
      agentId: normalizeAgentId(options.agentId),
      createdAt: new Date().toISOString(),
    });
    this.write(data);
    return data.notes[data.notes.length - 1];
  }

  getRecentConversations(limit = 12, agentId = "") {
    return this.filterByAgent(this.read().conversations, agentId).slice(-limit);
  }

  getNotes(agentId = "") {
    return this.filterByAgent(this.read().notes, agentId);
  }

  addResearch(entry) {
    const data = this.read();
    const record = {
      id: `research_${Date.now()}`,
      createdAt: new Date().toISOString(),
      agentId: normalizeAgentId(entry.agentId),
      ...entry,
    };
    data.research.push(record);
    this.write(data);
    return record;
  }

  getResearch(limit = 10, agentId = "") {
    return this.filterByAgent(this.read().research, agentId).slice(-limit);
  }

  addArtifact(entry) {
    const data = this.read();
    const record = {
      id: `artifact_${Date.now()}`,
      createdAt: new Date().toISOString(),
      agentId: normalizeAgentId(entry.agentId),
      ...entry,
    };
    data.artifacts.push(record);
    this.write(data);
    return record;
  }

  getArtifacts(limit = 10, agentId = "") {
    return this.filterByAgent(this.read().artifacts, agentId).slice(-limit);
  }

  addAttachmentExtract(entry = {}) {
    const data = this.read();
    const sourceId = String(entry.extractId || entry.sourceId || "").trim() || createId("attachment_extract_source");
    const agentId = normalizeAgentId(entry.agentId);
    const existingIndex = data.attachmentExtracts.findIndex(
      (item) => String(item.sourceId || item.extractId || "") === sourceId && normalizeAgentId(item.agentId) === agentId,
    );
    const record = {
      id: existingIndex === -1 ? createId("attachment_extract") : data.attachmentExtracts[existingIndex].id,
      sourceId,
      extractId: String(entry.extractId || sourceId).trim(),
      cacheId: String(entry.cacheId || "").trim(),
      deliveryId: String(entry.deliveryId || "").trim(),
      adapterId: String(entry.adapterId || "").trim(),
      agentId,
      sessionId: String(entry.sessionId || "").trim(),
      runId: String(entry.runId || "").trim(),
      title: truncate(entry.title || entry.name || "Imported attachment extract", 140),
      text: truncate(entry.text || "", 2400),
      status: String(entry.status || "completed").trim(),
      sourceRef: String(entry.sourceRef || `attachment-extract:${sourceId}`).trim(),
      tags: uniqueList(["attachment-extract", entry.adapterId, ...(entry.tags || [])]),
      createdAt: existingIndex === -1 ? new Date().toISOString() : data.attachmentExtracts[existingIndex].createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (existingIndex === -1) {
      data.attachmentExtracts.push(record);
      if (data.attachmentExtracts.length > 300) {
        data.attachmentExtracts = data.attachmentExtracts.slice(-300);
      }
    } else {
      data.attachmentExtracts[existingIndex] = record;
    }
    this.write(data);
    return record;
  }

  getLongTermMemory(limit = 50, agentId = "") {
    return this.filterByAgent(this.read().longTerm, agentId).slice(-limit).reverse();
  }

  getDreams(limit = 20, agentId = "") {
    return this.filterByAgent(this.read().dreams, agentId).slice(-limit).reverse();
  }

  getOverview(agentId = "") {
    const data = this.read();
    const scopedLongTerm = this.filterByAgent(data.longTerm, agentId);
    const scopedDreams = this.filterByAgent(data.dreams, agentId);
    const scopedCandidates = this.getPromotionCandidates({ agentId, limit: 50 });
    return {
      notes: this.filterByAgent(data.notes, agentId).length,
      conversations: this.filterByAgent(data.conversations, agentId).length,
      research: this.filterByAgent(data.research, agentId).length,
      artifacts: this.filterByAgent(data.artifacts, agentId).length,
      attachmentExtracts: this.filterByAgent(data.attachmentExtracts, agentId).length,
      longTerm: scopedLongTerm.length,
      dreams: scopedDreams.length,
      candidates: scopedCandidates.length,
      markdownPath: this.markdownPath,
      lastDreamAt: scopedDreams[scopedDreams.length - 1]?.createdAt || null,
    };
  }

  promoteMemory(input = {}) {
    const data = this.read();
    const sourceType = String(input.sourceType || "manual").trim();
    const sourceId = String(input.sourceId || "").trim();
    const sourceRef = sourceId ? `${sourceType}:${sourceId}` : `manual:${createId("source")}`;
    const existing = data.longTerm.find((item) => item.sourceRef === sourceRef);
    if (existing) {
      return {
        created: false,
        memory: existing,
        markdown: this.syncMarkdown(),
      };
    }

    const record = {
      id: createId("memory"),
      agentId: normalizeAgentId(input.agentId),
      title: truncate(input.title || "Promoted memory", 140),
      text: truncate(input.text || "", 2000),
      sourceType,
      sourceId,
      sourceRef,
      importance: String(input.importance || "medium").trim().toLowerCase(),
      tags: uniqueList(input.tags || []),
      createdAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.longTerm.push(record);
    this.write(data);
    return {
      created: true,
      memory: record,
      markdown: this.syncMarkdown(),
    };
  }

  buildCandidate({ sourceType, sourceId, agentId, title, text, score, reason, tags = [] }) {
    return {
      id: `${sourceType}:${sourceId}`,
      sourceType,
      sourceId,
      agentId: normalizeAgentId(agentId),
      title: truncate(title, 140),
      text: truncate(text, 1400),
      score: Number(score || 0),
      reason,
      tags: uniqueList(tags),
    };
  }

  getPromotionCandidates({ limit = 12, agentId = "" } = {}) {
    const data = this.read();
    const promoted = new Set(data.longTerm.map((item) => item.sourceRef).filter(Boolean));
    const candidates = [];

    for (const note of this.filterByAgent(data.notes, agentId)) {
      const sourceRef = `note:${note.id}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      candidates.push(
        this.buildCandidate({
          sourceType: "note",
          sourceId: note.id,
          agentId: note.agentId,
          title: truncate(note.text, 90) || "Memory note",
          text: note.text,
          score: 0.7,
          reason: "Explicit user note saved with remember.",
          tags: ["note"],
        }),
      );
    }

    for (const conversation of this.filterByAgent(data.conversations, agentId).slice(-30)) {
      const sourceRef = `conversation:${conversation.runId || conversation.at}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      const intents = Array.isArray(conversation.intents) ? conversation.intents : [];
      const importantIntent = intents.some((intent) =>
        ["planning", "config-update", "skill-create", "research", "file-write", "shell-plan"].includes(intent),
      );
      candidates.push(
        this.buildCandidate({
          sourceType: "conversation",
          sourceId: conversation.runId || conversation.at,
          agentId: conversation.agentId,
          title: truncate(conversation.user || "Conversation", 90),
          text: `User: ${conversation.user || ""}\nAssistant: ${conversation.assistant || ""}`,
          score: importantIntent ? 0.8 : 0.45,
          reason: importantIntent ? `Important intent(s): ${intents.join(", ")}` : "Recent conversation context.",
          tags: ["conversation", ...intents.slice(0, 3)],
        }),
      );
    }

    for (const research of this.filterByAgent(data.research, agentId)) {
      const sourceRef = `research:${research.id}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      const first = research.results?.[0];
      candidates.push(
        this.buildCandidate({
          sourceType: "research",
          sourceId: research.id,
          agentId: research.agentId,
          title: research.query || first?.title || "Research memory",
          text: [
            `Query: ${research.query || ""}`,
            ...(research.results || [])
              .slice(0, 3)
              .map((result) => `- ${result.title || result.url || "result"} ${result.url || ""}`),
          ].join("\n"),
          score: 0.72,
          reason: "Research result can support future answers.",
          tags: ["research"],
        }),
      );
    }

    for (const extract of this.filterByAgent(data.attachmentExtracts, agentId)) {
      const sourceId = extract.sourceId || extract.extractId || extract.id;
      const sourceRef = `attachment-extract:${sourceId}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      candidates.push(
        this.buildCandidate({
          sourceType: "attachment-extract",
          sourceId,
          agentId: extract.agentId,
          title: extract.title || "Imported attachment extract",
          text: extract.text,
          score: extract.status === "completed" ? 0.78 : 0.58,
          reason: "Attachment text was imported into an OmniClaw session and may be useful later.",
          tags: extract.tags || ["attachment-extract"],
        }),
      );
    }

    return candidates.sort((left, right) => right.score - left.score).slice(0, Number(limit || 12));
  }

  async scoreCandidatesWithModel(candidates, provider) {
    if (!candidates || candidates.length === 0 || !provider) {
      return candidates;
    }

    const prompt = `Review the following memory candidates and score them for long-term storage.
Return a JSON array of objects, each containing:
- id: (string) matches the input candidate id
- score: (number 0.0 to 1.0) higher means more valuable
- reason: (string) short explanation of why this is valuable or not
- title: (string) a better, more descriptive title if needed
- tags: (string array) 2-3 relevant tags

Scoring Criteria:
1. Novelty: Does it contain new information not likely in the model's base training?
2. Utility: How useful will this be for future task execution or user preferences?
3. Importance: Is it a key decision, a complex research result, or a specific user instruction?

Candidates:
${JSON.stringify(candidates.map(c => ({ id: c.id, title: c.title, text: c.text })), null, 2)}`;

    try {
      const response = await provider.complete([
        { role: "system", content: "You are a memory consolidation expert. You only output valid JSON arrays." },
        { role: "user", content: prompt }
      ]);

      const text = response.text || "[]";
      const scores = JSON.parse(text.match(/\[.*\]/s)?.[0] || "[]");
      const scoreMap = new Map(scores.map(s => [s.id, s]));

      return candidates.map(c => {
        const update = scoreMap.get(c.id);
        if (!update) return c;
        return {
          ...c,
          score: update.score ?? c.score,
          reason: update.reason ?? c.reason,
          title: update.title ?? c.title,
          tags: uniqueList([...(c.tags || []), ...(update.tags || [])]),
        };
      });
    } catch (error) {
      console.error("Dreaming score error:", error);
      return candidates; // Fallback to heuristic scores
    }
  }

  async runDreamSweep({ agentId = "", limit = 5, minScore = 0.65, source = "manual", provider = null } = {}) {
    let candidates = this.getPromotionCandidates({ agentId, limit: Math.max(Number(limit || 5), 1) * 3 });
    
    if (provider) {
      candidates = await this.scoreCandidatesWithModel(candidates, provider);
    }

    const finalCandidates = candidates
      .filter((candidate) => candidate.score >= Number(minScore || 0.65))
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(limit || 5));

    const promoted = finalCandidates.map((candidate) =>
      this.promoteMemory({
        agentId: candidate.agentId,
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        title: candidate.title,
        text: candidate.text,
        importance: candidate.score >= 0.78 ? "high" : "medium",
        tags: ["dream", ...candidate.tags],
      }).memory,
    );
    const data = this.read();
    const dream = {
      id: createId("dream"),
      agentId: normalizeAgentId(agentId),
      source,
      createdAt: new Date().toISOString(),
      candidateCount: candidates.length,
      promotedCount: promoted.length,
      promotedMemoryIds: promoted.map((item) => item.id),
      summary:
        promoted.length > 0
          ? `Promoted ${promoted.length} memory item(s): ${promoted.map((item) => item.title).join("; ")}`
          : "No memory candidates met the promotion threshold.",
    };
    data.dreams.push(dream);
    this.write(data);
    this.syncMarkdown();
    return {
      dream,
      promoted,
      candidates,
    };
  }
}
