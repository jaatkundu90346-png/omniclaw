import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function textToVector(text, dimensions = 32) {
  const vec = new Array(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    vec[charCode % dimensions] += charCode;
  }
  const max = Math.max(...vec, 1);
  return vec.map((v) => v / max);
}

export class MemorySDK {
  constructor({ rootDir, memoryStore, configStore }) {
    this.rootDir = rootDir;
    this.memoryStore = memoryStore;
    this.configStore = configStore;
    this.citationsEnabled = true;
    this.artifactsDir = path.join(rootDir, "data", "memory", "artifacts");
    fs.mkdirSync(this.artifactsDir, { recursive: true });
  }

  async search(query, options = {}) {
    const { agentId = "main", limit = 10, minScore = 0.3, includeCitations = true } = options;
    const queryVector = textToVector(query);

    const conversations = this.memoryStore?.getRecentConversations?.(200, agentId) || [];
    const longTerm = this.memoryStore?.getLongTermMemory?.(100, agentId) || [];
    const notes = this.memoryStore?.getNotes?.(agentId) || [];

    const allItems = [
      ...conversations.map((c) => ({ ...c, type: "conversation", text: c.text || "" })),
      ...longTerm.map((m) => ({ ...m, type: "long-term", text: m.summary || m.text || "" })),
      ...notes.map((n) => ({ ...n, type: "note", text: n.text || "" })),
    ];

    const scored = allItems
      .map((item) => {
        const itemVector = textToVector(item.text);
        const score = cosineSimilarity(queryVector, itemVector);
        return { ...item, score };
      })
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results = scored.map((item) => {
      const result = {
        id: item.id,
        type: item.type,
        score: item.score.toFixed(3),
        text: item.text?.slice(0, 500),
        timestamp: item.timestamp || item.createdAt || "",
      };

      if (includeCitations && this.citationsEnabled) {
        result.citation = {
          source: item.type,
          agentId,
          id: item.id,
          retrievedAt: new Date().toISOString(),
          relevance: item.score >= 0.7 ? "high" : item.score >= 0.5 ? "medium" : "low",
        };
      }

      return result;
    });

    return {
      query,
      results,
      total: results.length,
      searchTime: Date.now(),
      citationsIncluded: includeCitations && this.citationsEnabled,
    };
  }

  async promoteMemory({ noteId, agentId = "main", summary, tags = [] }) {
    // MemoryStore.promoteMemory reads input.text / input.title and dedupes on
    // `${sourceType}:${sourceId}` — passing `summary`/`noteId` straight through
    // promoted an EMPTY-TEXT memory every call, and the result was then tested
    // against `promoted`, a key the store never returns, so the citation branch
    // was unreachable. Map to the real parameter names and check a real key.
    const result = this.memoryStore?.promoteMemory?.({
      text: summary,
      title: String(summary || "").trim().split(/\r?\n/)[0].slice(0, 120),
      sourceType: "note",
      sourceId: noteId,
      agentId,
      tags,
    });

    // The store returns { created, memory, markdown } on both paths.
    if (result?.memory) {
      this.recordCitation("promote", {
        sourceNoteId: noteId,
        agentId,
        summary,
        tags,
        memoryId: result.memory.id,
        created: Boolean(result.created),
        promotedAt: new Date().toISOString(),
      });
    }

    return result || { promoted: false, reason: "memory-store-unavailable" };
  }

  async createArtifact({ title, content, type = "text", agentId = "main", metadata = {} }) {
    const id = generateId("artifact");
    const filePath = path.join(this.artifactsDir, `${id}.json`);

    const artifact = {
      id,
      title,
      content,
      type,
      agentId,
      metadata,
      createdAt: new Date().toISOString(),
      citations: [],
    };

    // Atomic (temp + rename): a half-written artifact JSON was unparseable.
    atomicWriteFileSync(filePath, JSON.stringify(artifact, null, 2));

    return {
      created: true,
      id,
      filePath,
      title,
      type,
    };
  }

  getArtifact(id) {
    const filePath = path.join(this.artifactsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  listArtifacts(agentId, limit = 20) {
    if (!fs.existsSync(this.artifactsDir)) return [];
    const files = fs.readdirSync(this.artifactsDir).filter((f) => f.endsWith(".json"));
    const artifacts = files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.artifactsDir, f), "utf8"));
        } catch { return null; }
      })
      .filter(Boolean)
      .filter((a) => !agentId || a.agentId === agentId)
      .slice(0, limit);

    return artifacts.map((a) => ({
      id: a.id,
      title: a.title,
      type: a.type,
      agentId: a.agentId,
      createdAt: a.createdAt,
    }));
  }

  recordCitation(action, details) {
    const citation = {
      action,
      ...details,
      timestamp: new Date().toISOString(),
    };

    const citationsPath = path.join(this.artifactsDir, "citations.jsonl");
    fs.appendFileSync(citationsPath, JSON.stringify(citation) + "\n");
    // Rotation: this file was append-only forever. Once it passes 1MB keep only
    // the newest 1000 lines. Citations are an audit trail, not durable memory,
    // so dropping the oldest is the correct trade (and it bounds disk growth).
    try {
      const size = fs.statSync(citationsPath).size;
      if (size > 1024 * 1024) {
        const lines = fs.readFileSync(citationsPath, "utf8").split("\n").filter(Boolean);
        const kept = lines.slice(-1000);
        atomicWriteFileSync(citationsPath, `${kept.join("\n")}\n`);
      }
    } catch (error) {
      // Rotation is opportunistic: a failure here must not fail the citation.
      console.warn("[memory] citations rotation:", error.message);
    }
  }

  getCitations(limit = 50) {
    const citationsPath = path.join(this.artifactsDir, "citations.jsonl");
    if (!fs.existsSync(citationsPath)) return [];
    const content = fs.readFileSync(citationsPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  getMemoryOverview(agentId = "main") {
    return {
      notes: this.memoryStore?.getNotes?.(agentId)?.length || 0,
      conversations: this.memoryStore?.getRecentConversations?.(999, agentId)?.length || 0,
      longTerm: this.memoryStore?.getLongTermMemory?.(999, agentId)?.length || 0,
      dreams: this.memoryStore?.getDreams?.(999, agentId)?.length || 0,
      artifacts: this.listArtifacts(agentId).length,
      citations: this.getCitations(1).length,
      citationsEnabled: this.citationsEnabled,
    };
  }

  getStatus() {
    return {
      citationsEnabled: this.citationsEnabled,
      artifactsDir: this.artifactsDir,
      sdkVersion: "0.1.0",
      features: ["search", "promote", "artifacts", "citations", "overview"],
    };
  }
}
