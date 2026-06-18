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

function tokenize(value = "") {
  return String(value || "").toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
}

function scoreText(query = "", text = "") {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  const haystack = String(text || "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
    score += tokenize(text).filter((item) => item === term).length;
  }
  return score / Math.max(1, terms.length);
}

export class MemoryStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "data", "memory.json");
    this.markdownPath = path.join(rootDir, "data", "MEMORY.md");
    this.cache = null;
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
    const stat = fs.statSync(this.filePath);
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.data;
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const data = {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      research: Array.isArray(parsed.research) ? parsed.research : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      attachmentExtracts: Array.isArray(parsed.attachmentExtracts) ? parsed.attachmentExtracts : [],
      longTerm: Array.isArray(parsed.longTerm) ? parsed.longTerm : [],
      dreams: Array.isArray(parsed.dreams) ? parsed.dreams : [],
    };
    this.cache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data,
    };
    return data;
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    const stat = fs.statSync(this.filePath);
    this.cache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data,
    };
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

  getAgentWorkspaceMemoryDir(agentId = "main") {
    return path.join(this.rootDir, "workspace", "agents", normalizeAgentId(agentId), "memory");
  }

  getLayeredMemoryPaths(agentId = "main") {
    const agentDir = path.join(this.rootDir, "workspace", "agents", normalizeAgentId(agentId));
    const memoryDir = this.getAgentWorkspaceMemoryDir(agentId);
    const today = new Date().toISOString().slice(0, 10);
    return {
      sessionTranscriptDir: path.join(this.rootDir, "data", "sessions", "transcripts"),
      dailyMemoryDir: memoryDir,
      dailyMemoryPath: path.join(memoryDir, `${today}.md`),
      longTermMemoryPath: path.join(agentDir, "MEMORY.md"),
      dreamsPath: path.join(agentDir, "DREAMS.md"),
      jsonMemoryPath: this.filePath,
      generatedLongTermPath: this.markdownPath,
    };
  }

  ensureLayeredMemoryFiles(agentId = "main") {
    const paths = this.getLayeredMemoryPaths(agentId);
    fs.mkdirSync(paths.dailyMemoryDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.longTermMemoryPath), { recursive: true });
    if (!fs.existsSync(paths.dailyMemoryPath)) {
      fs.writeFileSync(paths.dailyMemoryPath, `# Daily Memory ${new Date().toISOString().slice(0, 10)}\n\n`, "utf8");
    }
    if (!fs.existsSync(paths.longTermMemoryPath)) {
      fs.writeFileSync(paths.longTermMemoryPath, "# MEMORY\n\nDurable facts, preferences, decisions, and action boundaries.\n\n", "utf8");
    }
    if (!fs.existsSync(paths.dreamsPath)) {
      fs.writeFileSync(paths.dreamsPath, "# DREAMS\n\nReview summaries and memory compaction notes.\n\n", "utf8");
    }
    return paths;
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

  writeLayeredMemory({
    type = "daily",
    content = "",
    source = "manual",
    expiry = "",
    actionBoundary = "",
    agentId = "main",
    sessionId = "",
    runId = "",
  } = {}) {
    const text = truncate(content, 4000);
    if (!text) {
      return { ok: false, error: "content is required" };
    }
    const normalizedType = String(type || "daily").toLowerCase();
    const paths = this.ensureLayeredMemoryFiles(agentId);
    const at = new Date().toISOString();
    const boundaryLine = actionBoundary ? `Action boundary: ${actionBoundary}` : "";
    const meta = [
      `Source: ${source || "manual"}`,
      sessionId ? `Session: ${sessionId}` : "",
      runId ? `Run: ${runId}` : "",
      expiry ? `Expiry: ${expiry}` : "",
      boundaryLine,
    ].filter(Boolean);
    const entry = [
      `\n## ${normalizedType} (${at})`,
      ...meta.map((line) => `- ${line}`),
      "",
      text,
      "",
    ].join("\n");

    if (["long-term", "longterm", "durable", "memory"].includes(normalizedType)) {
      fs.appendFileSync(paths.longTermMemoryPath, entry, "utf8");
      const promoted = this.promoteMemory({
        text,
        title: text.split(/\r?\n/)[0].slice(0, 120) || "Manual memory",
        sourceType: "memory_write",
        sourceId: runId || sessionId || createId("manual_memory"),
        agentId,
        importance: actionBoundary ? "high" : "medium",
        tags: uniqueList(["memory-write", actionBoundary ? "action-boundary" : "", normalizedType]),
        actionBoundary,
        expiry,
      });
      return { ok: true, layer: "longTerm", path: paths.longTermMemoryPath, memory: promoted.memory || promoted, actionBoundary };
    }

    const note = this.addNote(text, { agentId });
    fs.appendFileSync(paths.dailyMemoryPath, entry, "utf8");
    return { ok: true, layer: "daily", path: paths.dailyMemoryPath, note, actionBoundary };
  }

  getLayeredMemory({ file = "overview", range = "", agentId = "main" } = {}) {
    const paths = this.ensureLayeredMemoryFiles(agentId);
    const key = String(file || "overview").toLowerCase();
    if (key === "overview") {
      return {
        overview: this.getOverview(agentId),
        paths,
        layers: {
          sessionTranscript: paths.sessionTranscriptDir,
          dailyMemory: paths.dailyMemoryPath,
          longTermMemory: paths.longTermMemoryPath,
          dreams: paths.dreamsPath,
        },
        recent: {
          conversations: this.getRecentConversations(6, agentId),
          notes: this.getNotes(agentId).slice(-8),
          longTerm: this.getLongTermMemory(8, agentId),
        },
      };
    }
    const filePath = key.includes("dream") ? paths.dreamsPath
      : key.includes("daily") || key.includes("today") ? paths.dailyMemoryPath
      : key.includes("json") ? paths.jsonMemoryPath
      : paths.longTermMemoryPath;
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const lines = content.split(/\r?\n/);
    const match = String(range || "").match(/(\d+)\s*-\s*(\d+)/);
    const selected = match
      ? lines.slice(Math.max(0, Number(match[1]) - 1), Math.min(lines.length, Number(match[2]))).join("\n")
      : content;
    return { file, path: filePath, range: range || "", content: truncate(selected, 12000), lineCount: lines.length };
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
    const agentId = normalizeAgentId(input.agentId);
    const sourceType = String(input.sourceType || "manual").trim();
    const sourceId = String(input.sourceId || "").trim();
    const sourceRef = sourceId ? `${sourceType}:${sourceId}` : `manual:${createId("source")}`;
    const existing = data.longTerm.find(
      (item) => item.sourceRef === sourceRef && normalizeAgentId(item.agentId) === agentId,
    );
    if (existing) {
      return {
        created: false,
        memory: existing,
        markdown: this.syncMarkdown(),
      };
    }

    const record = {
      id: createId("memory"),
      agentId,
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

  // ─── Search Methods ───────────────────────────────────────────
  searchNotes(query, agentId = "") {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    return this.filterByAgent(this.read().notes, agentId).filter(note =>
      String(note.text || "").toLowerCase().includes(q)
    );
  }

  searchLongTerm(query, agentId = "") {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    return this.filterByAgent(this.read().longTerm, agentId).filter(item =>
      (item.title || "").toLowerCase().includes(q) ||
      (item.text || "").toLowerCase().includes(q) ||
      (item.tags || []).some(tag => tag.toLowerCase().includes(q))
    );
  }

  searchResearch(query, agentId = "") {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    return this.filterByAgent(this.read().research, agentId).filter(item =>
      (item.query || "").toLowerCase().includes(q) ||
      JSON.stringify(item.results || []).toLowerCase().includes(q)
    );
  }

  searchArtifacts(query, agentId = "") {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    return this.filterByAgent(this.read().artifacts, agentId).filter(item =>
      (item.path || "").toLowerCase().includes(q) ||
      (item.kind || "").toLowerCase().includes(q)
    );
  }

  searchAll(query, agentId = "") {
    const q = String(query || "").toLowerCase().trim();
    const data = this.read();
    const conversations = !q ? [] : this.filterByAgent(data.conversations, agentId).filter(item =>
      (item.user || "").toLowerCase().includes(q) ||
      (item.assistant || "").toLowerCase().includes(q) ||
      JSON.stringify(item.intents || []).toLowerCase().includes(q)
    );
    const attachmentExtracts = !q ? [] : this.filterByAgent(data.attachmentExtracts, agentId).filter(item =>
      (item.title || "").toLowerCase().includes(q) ||
      (item.text || "").toLowerCase().includes(q) ||
      JSON.stringify(item.tags || []).toLowerCase().includes(q)
    );
    return {
      notes: this.searchNotes(query, agentId),
      longTerm: this.searchLongTerm(query, agentId),
      research: this.searchResearch(query, agentId),
      artifacts: this.searchArtifacts(query, agentId),
      conversations,
      attachmentExtracts,
    };
  }

  flattenMemoryItems(agentId = "") {
    const data = this.read();
    const make = (layer, item, text, title = "") => ({
      layer,
      id: item.id || `${layer}_${Math.random().toString(36).slice(2)}`,
      agentId: item.agentId || agentId || "main",
      title,
      text: truncate(text, 2200),
      item,
    });
    return [
      ...this.filterByAgent(data.conversations, agentId).map((item) =>
        make("session", item, [item.user, item.assistant, JSON.stringify(item.toolOutputs || [])].join("\n"), item.sessionId || item.runId || "conversation")),
      ...this.filterByAgent(data.notes, agentId).map((item) => make("daily", item, item.text, "note")),
      ...this.filterByAgent(data.longTerm, agentId).map((item) => make("longTerm", item, `${item.title || ""}\n${item.text || ""}\n${(item.tags || []).join(" ")}`, item.title || "long-term")),
      ...this.filterByAgent(data.research, agentId).map((item) => make("research", item, `${item.query || ""}\n${JSON.stringify(item.results || [])}`, item.query || "research")),
      ...this.filterByAgent(data.artifacts, agentId).map((item) => make("artifact", item, `${item.kind || ""}\n${item.path || ""}`, item.path || item.kind || "artifact")),
      ...this.filterByAgent(data.attachmentExtracts, agentId).map((item) => make("attachment", item, `${item.title || ""}\n${item.text || ""}\n${(item.tags || []).join(" ")}`, item.title || "attachment")),
    ];
  }

  async hybridSearch({ query = "", limit = 12, scope = "all", agentId = "", semanticMemory = null } = {}) {
    const q = String(query || "").trim();
    if (!q) {
      return { query: q, results: [], count: 0, mode: "empty-query" };
    }
    const normalizedScope = String(scope || "all").trim();
    const allItems = this.flattenMemoryItems(agentId)
      .filter((item) => normalizedScope === "all" || item.layer === normalizedScope);
    const keywordResults = allItems
      .map((item) => ({
        ...item,
        keywordScore: scoreText(q, `${item.title}\n${item.text}`),
      }))
      .filter((item) => item.keywordScore > 0);

    let semanticResults = [];
    if (semanticMemory?.searchText) {
      try {
        semanticResults = await semanticMemory.searchText(q, Math.max(limit, 12), 0.2);
      } catch {
        semanticResults = [];
      }
    }
    const semanticById = new Map(semanticResults.map((item) => [item.id, item]));
    const merged = keywordResults.map((item) => {
      const semantic = semanticById.get(item.id);
      const semanticScore = Number(semantic?.similarity || 0);
      return {
        layer: item.layer,
        id: item.id,
        title: item.title,
        preview: truncate(item.text, 700),
        keywordScore: Number(item.keywordScore.toFixed(3)),
        semanticScore: Number(semanticScore.toFixed(3)),
        score: Number((item.keywordScore * 0.7 + semanticScore * 3).toFixed(3)),
        source: item.item.sourceRef || item.item.path || item.item.sessionId || item.layer,
        item: item.item,
      };
    }).sort((left, right) => right.score - left.score).slice(0, Math.max(1, Number(limit || 12)));

    return {
      query: q,
      scope: normalizedScope,
      mode: semanticResults.length ? "keyword+semantic" : "keyword",
      results: merged,
      count: merged.length,
      layers: {
        session: merged.filter((item) => item.layer === "session").length,
        daily: merged.filter((item) => item.layer === "daily").length,
        longTerm: merged.filter((item) => item.layer === "longTerm").length,
        research: merged.filter((item) => item.layer === "research").length,
      },
    };
  }

  compactLayeredMemory({ agentId = "main", dryRun = false, maxItems = 12 } = {}) {
    const paths = this.ensureLayeredMemoryFiles(agentId);
    const daily = fs.existsSync(paths.dailyMemoryPath) ? fs.readFileSync(paths.dailyMemoryPath, "utf8") : "";
    const candidates = [
      ...this.getNotes(agentId).slice(-Number(maxItems || 12)).map((note) => ({
        title: truncate(note.text, 80),
        text: note.text,
        sourceRef: `note:${note.id}`,
        tags: ["daily-note"],
      })),
      ...(daily.match(/Action boundary:[^\n]+[\s\S]{0,600}/g) || []).map((text, index) => ({
        title: `Action boundary ${index + 1}`,
        text,
        sourceRef: `daily:${path.basename(paths.dailyMemoryPath)}#boundary-${index + 1}`,
        tags: ["action-boundary"],
      })),
    ].slice(0, Number(maxItems || 12));

    if (dryRun) {
      return { ok: true, dryRun: true, candidates, paths };
    }

    const promoted = candidates.map((candidate) => this.promoteMemory({
      ...candidate,
      agentId,
      sourceType: "memory_compact",
      sourceId: candidate.sourceRef,
      importance: candidate.tags.includes("action-boundary") ? "high" : "medium",
    }));
    const dreamEntry = [
      `\n## Memory compaction (${new Date().toISOString()})`,
      `- Promoted: ${promoted.length}`,
      `- Daily source: ${paths.dailyMemoryPath}`,
      "",
    ].join("\n");
    fs.appendFileSync(paths.dreamsPath, dreamEntry, "utf8");
    this.syncMarkdown();
    return { ok: true, promotedCount: promoted.length, promoted, paths };
  }

  prefetchAll({ query = "", agentId = "", limit = 12 } = {}) {
    const overview = this.getOverview(agentId);
    const search = query ? this.searchAll(query, agentId) : null;
    return {
      agentId: normalizeAgentId(agentId),
      overview,
      recentConversations: this.getRecentConversations(limit, agentId),
      notes: this.getNotes(agentId).slice(-limit),
      longTermMemory: this.getLongTermMemory(limit, agentId),
      dreams: this.getDreams(Math.min(limit, 8), agentId),
      search,
      lifecycle: [
        "prefetch_all: gather memory before LLM call",
        "fenced block: inject as memory/context data, not active instructions",
        "sync_all: persist notes, conversations, research, artifacts, and promoted memory after turn",
        "queue_prefetch_all: heartbeat/dream sweep refreshes candidates for future turns",
      ],
      providerRule: "Built-in JSON + MEMORY.md provider is always present; external memory plugins should be additive and not replace core memory.",
    };
  }

  // ─── Three-Layer Memory (Mavis-Style) ──────────────────────────────

  /**
   * Get Mavis-style memory paths.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} agentId - Agent ID for agent-scoped memory
   * @returns {Object} Memory paths
   */
  getMemoryPaths(scope, agentId = "main") {
    const homeDir = process.env.HOME || process.env.USERPROFILE || this.rootDir;
    const mavisDir = path.join(homeDir, ".mavis");

    return {
      user: {
        base: path.join(mavisDir, "memory"),
        memoryMd: path.join(mavisDir, "memory", "user.md"),
      },
      agent: {
        base: path.join(mavisDir, "agents", agentId, "memory"),
        memoryMd: path.join(mavisDir, "agents", agentId, "memory", "MEMORY.md"),
        topicsDir: path.join(mavisDir, "agents", agentId, "memory", "topics"),
      },
      project: {
        base: this.rootDir,
        agentsMd: path.join(this.rootDir, "AGENTS.md"),
        claudeMd: path.join(this.rootDir, "CLAUDE.md"),
      },
    }[scope];
  }

  /**
   * Ensure memory directory structure exists.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} agentId - Agent ID
   */
  ensureMemoryDir(scope, agentId = "main") {
    const paths = this.getMemoryPaths(scope, agentId);
    fs.mkdirSync(path.dirname(paths.memoryMd), { recursive: true });
    if (scope === "agent" && paths.topicsDir) {
      fs.mkdirSync(paths.topicsDir, { recursive: true });
    }
  }

  /**
   * Read memory content for given scope.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} topic - Optional topic file name (for agent scope)
   * @param {string} agentId - Agent ID for agent-scoped memory
   * @returns {string} Memory content
   */
  getMemory(scope, topic = null, agentId = "main") {
    const paths = this.getMemoryPaths(scope, agentId);

    if (scope === "project") {
      const agentsMd = fs.existsSync(paths.agentsMd) ? fs.readFileSync(paths.agentsMd, "utf-8") : "";
      const claudeMd = fs.existsSync(paths.claudeMd) ? fs.readFileSync(paths.claudeMd, "utf-8") : "";
      return agentsMd || claudeMd || "";
    }

    if (scope === "agent" && topic) {
      const topicPath = path.join(paths.topicsDir, `${topic}.md`);
      if (fs.existsSync(topicPath)) {
        return fs.readFileSync(topicPath, "utf-8");
      }
      return "";
    }

    if (fs.existsSync(paths.memoryMd)) {
      return fs.readFileSync(paths.memoryMd, "utf-8");
    }
    return "";
  }

  /**
   * Append memory entry to given scope.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} content - Memory content to append
   * @param {string} type - Memory type: 'user', 'feedback', 'reference', 'pattern', 'gotcha', 'lesson'
   * @param {string} agentId - Agent ID for agent-scoped memory
   * @returns {Object} Append result
   */
  appendMemory(scope, content, type = "feedback", agentId = "main") {
    this.ensureMemoryDir(scope, agentId);
    const paths = this.getMemoryPaths(scope, agentId);

    const date = new Date().toISOString().split("T")[0];
    const entry = [
      "",
      `### ${scope}_${type} (${date})`,
      `Type: ${type}`,
      "",
      content,
    ].join("\n");

    fs.appendFileSync(paths.memoryMd, entry + "\n");

    return {
      scope,
      type,
      agentId,
      path: paths.memoryMd,
      size: fs.statSync(paths.memoryMd).size,
    };
  }

  /**
   * List topic files for an agent.
   * @param {string} agentId - Agent ID
   * @returns {Array} List of topics with metadata
   */
  listTopics(agentId = "main") {
    const paths = this.getMemoryPaths("agent", agentId);
    if (!fs.existsSync(paths.topicsDir)) {
      return [];
    }

    return fs.readdirSync(paths.topicsDir)
      .filter(f => f.endsWith(".md"))
      .map(f => {
        const filePath = path.join(paths.topicsDir, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8");
        const descriptionMatch = content.match(/description:\s*(.+)/i);

        return {
          name: f.replace(/\.md$/, ""),
          file: f,
          path: filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          description: descriptionMatch ? descriptionMatch[1].trim() : "",
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /**
   * Search memory across all layers.
   * @param {string} query - Search query
   * @param {string} scope - Optional scope filter: 'user', 'agent', 'project', or 'all'
   * @param {string} agentId - Agent ID for search
   * @returns {Object} Search results per layer
   */
  searchMemory(query, scope = "all", agentId = "main") {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return { results: [], count: 0 };

    const results = [];
    const scopesToSearch = scope === "all"
      ? ["user", "agent", "project"]
      : [scope];

    for (const s of scopesToSearch) {
      const content = this.getMemory(s, null, agentId);
      if (content) {
        const lines = content.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(q)) {
            results.push({
              scope: s,
              agentId: s === "agent" ? agentId : null,
              line: idx + 1,
              text: line.trim(),
              preview: lines.slice(Math.max(0, idx - 2), idx + 3).join("\n"),
            });
          }
        });
      }
    }

    return {
      query: q,
      scopes: scopesToSearch,
      results,
      count: results.length,
    };
  }

  /**
   * Get memory size and check constraints.
   * @param {string} scope - 'user' or 'agent'
   * @param {string} agentId - Agent ID
   * @returns {Object} Size info and constraints status
   */
  getMemorySizeInfo(scope, agentId = "main") {
    const paths = this.getMemoryPaths(scope, agentId);
    const MEMORY_SOFT_LIMIT = 15 * 1024; // 15KB soft limit
    const MEMORY_HARD_LIMIT = 20 * 1024; // 20KB hard limit
    const TOPIC_SOFT_LIMIT = 30 * 1024; // 30KB per topic

    let size = 0;
    if (fs.existsSync(paths.memoryMd)) {
      size = fs.statSync(paths.memoryMd).size;
    }

    const topics = scope === "agent" ? this.listTopics(agentId) : [];
    const oversizedTopics = topics.filter(t => t.size > TOPIC_SOFT_LIMIT);

    return {
      scope,
      agentId,
      memorySize: size,
      memorySizeFormatted: `${(size / 1024).toFixed(1)} KB`,
      softLimit: MEMORY_SOFT_LIMIT,
      hardLimit: MEMORY_HARD_LIMIT,
      withinSoftLimit: size <= MEMORY_SOFT_LIMIT,
      withinHardLimit: size <= MEMORY_HARD_LIMIT,
      topicCount: topics.length,
      topicSizeLimit: TOPIC_SOFT_LIMIT,
      oversizedTopics,
      status: size > MEMORY_HARD_LIMIT ? "exceeded" :
              size > MEMORY_SOFT_LIMIT ? "warning" : "ok",
    };
  }
}
