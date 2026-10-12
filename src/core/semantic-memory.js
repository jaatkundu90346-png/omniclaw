import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

function fnvHash(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

export class SimpleTextEmbedder {
  constructor({ dimensions = 256 } = {}) {
    this.dimensions = dimensions;
  }

  async embed(text = "") {
    const vector = new Array(this.dimensions).fill(0);
    // Latin + Devanagari (Hinglish); unigrams + word BIGRAMS so short phrases
    // ("dark theme", "port 3147") carry more signal than a pure bag of words.
    const tokens = String(text || "")
      .toLowerCase()
      .match(/[a-z0-9_ऀ-ॿ]{2,}/g) || [];
    for (const token of tokens) {
      vector[fnvHash(token) % this.dimensions] += 1;
    }
    for (let i = 0; i < tokens.length - 1; i += 1) {
      vector[fnvHash(`${tokens[i]}_${tokens[i + 1]}`) % this.dimensions] += 0.5;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map((value) => value / norm) : vector;
  }
}

// Real semantic embeddings via an OpenAI-compatible /embeddings endpoint when
// config.provider.embeddingsModel is set (e.g. "text-embedding-3-small", or a
// local server's model). Falls back to the lexical embedder when unconfigured
// or on any failure — memory recall never breaks because embeddings did.
export class AdaptiveEmbedder {
  constructor({ configStore, secretStore, fetchImpl = null } = {}) {
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.fetch = fetchImpl || globalThis.fetch?.bind(globalThis);
    this.simple = new SimpleTextEmbedder();
    this.cache = new Map(); // text-hash -> vector (session-lifetime)
    this.providerHealthy = true; // trips false after a failure; re-checked hourly
    this.lastFailureAt = 0;
  }

  getEmbeddingsConfig() {
    const provider = this.configStore?.getConfig?.()?.provider || {};
    const model = String(provider.embeddingsModel || "").trim();
    if (!model) return null;
    const baseUrl = String(provider.embeddingsBaseUrl || provider.baseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) return null;
    const keyProviderId = String(provider.embeddingsKeyProviderId || provider.apiKeyProviderId || "").trim();
    const apiKey = this.secretStore?.getProviderKey?.(keyProviderId) || "";
    return { model, baseUrl, apiKey };
  }

  async embed(text = "") {
    const body = String(text || "").slice(0, 8000);
    const cfg = this.getEmbeddingsConfig();
    if (!cfg || !this.fetch) return this.simple.embed(body);
    if (!this.providerHealthy && Date.now() - this.lastFailureAt < 3600000) {
      return this.simple.embed(body);
    }
    const cacheKey = `${cfg.model}:${fnvHash(body)}:${body.length}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    try {
      const response = await this.fetch(`${cfg.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, input: body }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      });
      if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
      const data = await response.json();
      const vector = data?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) throw new Error("no embedding in response");
      this.providerHealthy = true;
      if (this.cache.size > 2000) this.cache.clear();
      this.cache.set(cacheKey, vector);
      return vector;
    } catch {
      this.providerHealthy = false;
      this.lastFailureAt = Date.now();
      return this.simple.embed(body);
    }
  }
}

/**
 * SemanticMemory - A vector-based memory system for OmniClaw.
 * This module provides semantic search capabilities using embeddings.
 */

export class SemanticMemory {
  constructor({ rootDir, embedder = null }) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, "data", "semantic-memory");
    this.embedder = embedder;
    this.embeddings = new Map();
    this.ensureDir();
    this.load();
  }

  ensureDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  load() {
    try {
      const filePath = path.join(this.dataDir, "embeddings.json");
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        this.embeddings = new Map(Object.entries(data));
      }
    } catch (error) {
      console.warn("Failed to load semantic memory embeddings:", error.message);
    }
  }

  save() {
    try {
      const filePath = path.join(this.dataDir, "embeddings.json");
      const data = Object.fromEntries(this.embeddings);
      // Atomic (temp + rename): a kill mid-write used to leave a truncated
      // embeddings.json that load() could never parse again.
      atomicWriteFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf8" });
    } catch (error) {
      console.warn("Failed to save semantic memory embeddings:", error.message);
    }
  }

  // The dimension every embedding in this store MUST share for cosine
  // similarity to mean anything. Taken from the first stored embedding. An
  // embeddings-API flap (real API up = e.g. 1536-dim, lexical fallback when it
  // is down = 256-dim) would otherwise fragment the index into two dimensions
  // that no single query vector can span — cosineSimilarity returns 0 across
  // dimensions, so half the memories silently become unsearchable. We pin the
  // store to one dimension and skip conflicting adds (see addMemory/backfill).
  canonicalDimension() {
    for (const entry of this.embeddings.values()) {
      const dim = Array.isArray(entry.embedding) ? entry.embedding.length : 0;
      if (dim > 0) return dim;
    }
    return 0;
  }

  // Observability: which dimensions are present, whether the index fragmented,
  // and how many conflicting adds were skipped. A large conflictsSkipped with
  // no new indexing usually means the embeddings model changed — reindex by
  // clearing data/semantic-memory/embeddings.json.
  dimensionInfo() {
    const dims = new Map();
    for (const entry of this.embeddings.values()) {
      const d = Array.isArray(entry.embedding) ? entry.embedding.length : 0;
      dims.set(d, (dims.get(d) || 0) + 1);
    }
    return {
      canonical: this.canonicalDimension(),
      dimensions: Object.fromEntries(dims),
      fragmented: dims.size > 1,
      conflictsSkipped: this.dimensionConflicts || 0,
    };
  }

  /**
   * Add a memory entry with its embedding.
   * @param {string} id - Unique identifier for the memory.
   * @param {string} text - The text content of the memory.
   * @param {Array<number>} embedding - The embedding vector.
   * @param {Object} metadata - Additional metadata.
   * @returns {boolean} true if stored, false if skipped (empty or dim-conflict).
   */
  addMemory(id, text, embedding, metadata = {}) {
    const dim = Array.isArray(embedding) ? embedding.length : 0;
    if (!dim) return false;
    const canonical = this.canonicalDimension();
    if (canonical && dim !== canonical) {
      // Conflicting dimension (embedder fell back, or model changed) — skip
      // rather than fragment the index. Retried on a later, consistent embed.
      this.dimensionConflicts = (this.dimensionConflicts || 0) + 1;
      return false;
    }
    this.embeddings.set(id, {
      text,
      embedding,
      metadata,
      timestamp: new Date().toISOString(),
    });
    this.prune();
    this.save();
    return true;
  }

  // Bound the index: this store had NO cap, so every promoted memory added a
  // permanent 256-float vector and embeddings.json grew without limit. Keep the
  // newest 5000 by insertion order (Map preserves it), which still spans years
  // of use while capping the file.
  prune(max = 5000) {
    if (this.embeddings.size <= max) return 0;
    const overflow = this.embeddings.size - max;
    let dropped = 0;
    for (const key of this.embeddings.keys()) {
      if (dropped >= overflow) break;
      this.embeddings.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  async addText(id, text, metadata = {}) {
    const embedding = await this.embedder?.embed?.(text);
    if (!embedding) {
      throw new Error("Semantic memory embedder is not configured.");
    }
    this.addMemory(id, text, embedding, metadata);
    return this.embeddings.get(id);
  }

  /**
   * Compute cosine similarity between two vectors.
   * @param {Array<number>} vec1 - First vector.
   * @param {Array<number>} vec2 - Second vector.
   * @returns {number} Similarity score between -1 and 1.
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) {
      return 0;
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Search for similar memories based on an embedding.
   * @param {Array<number>} queryEmbedding - The embedding of the query.
   * @param {number} limit - Maximum number of results to return.
   * @param {number} threshold - Minimum similarity threshold.
   * @returns {Array<Object>} Array of similar memories sorted by relevance.
   */
  search(queryEmbedding, limit = 10, threshold = 0.5) {
    const results = [];
    const qDim = Array.isArray(queryEmbedding) ? queryEmbedding.length : 0;
    if (!qDim) return results;

    for (const [id, entry] of this.embeddings) {
      // Only compare same-dimension vectors. Cross-dimension pairs can't be
      // scored (cosineSimilarity returns 0); skipping them avoids wasted work
      // and makes a dimension-flapped store degrade cleanly to its majority set.
      if (!Array.isArray(entry.embedding) || entry.embedding.length !== qDim) continue;
      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= threshold) {
        results.push({
          id,
          text: entry.text,
          similarity,
          metadata: entry.metadata,
          timestamp: entry.timestamp,
        });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async searchText(query, limit = 10, threshold = 0.35) {
    const embedding = await this.embedder?.embed?.(query);
    if (!embedding) {
      throw new Error("Semantic memory embedder is not configured.");
    }
    return this.search(embedding, limit, threshold);
  }

  // Index memory items that don't have embeddings yet (bounded, best-effort).
  // Without this the semantic index stayed EMPTY forever — nothing ever called
  // addText — so the "semantic" half of hybridSearch did nothing.
  async backfillFromItems(items = [], { max = 200 } = {}) {
    if (this._backfilling) return { indexed: 0, reason: "already-running" };
    this._backfilling = true;
    let indexed = 0;
    let skipped = 0;
    // Pin to the store's existing dimension so a fallback/degraded embedder
    // can't fragment the index mid-backfill; the first item sets it when empty.
    let canonical = this.canonicalDimension();
    try {
      for (const item of items) {
        if (indexed >= max) break;
        const id = String(item.id || "").trim();
        const text = String(item.text || "").trim();
        if (!id || !text || this.embeddings.has(id)) continue;
        try {
          const embedding = await this.embedder?.embed?.(text.slice(0, 4000));
          if (!embedding) break;
          const dim = Array.isArray(embedding) ? embedding.length : 0;
          if (!dim) continue;
          if (canonical && dim !== canonical) {
            // Dimension conflict (embedder fell back) — skip so the index stays
            // single-dimension and fully searchable; retried on a later run.
            this.dimensionConflicts = (this.dimensionConflicts || 0) + 1;
            skipped += 1;
            continue;
          }
          this.embeddings.set(id, {
            text: text.slice(0, 2000),
            embedding,
            metadata: { layer: item.layer || "", title: item.title || "" },
            timestamp: new Date().toISOString(),
          });
          if (!canonical) canonical = dim; // first stored entry pins the store
          indexed += 1;
        } catch { break; }
      }
      if (indexed > 0) {
        // Same bound as addMemory: a backfill run can push the index over the cap.
        this.prune();
        this.save();
      }
    } catch (error) {
      // Was fully swallowed: an embedder/IO failure aborted the backfill with
      // no record, so the semantic index stayed silently half-built.
      console.warn("[memory] backfillFromItems:", error.message);
    } finally {
      this._backfilling = false;
    }
    return { indexed, ...(skipped ? { skippedDimensionConflicts: skipped } : {}) };
  }

  /**
   * Get all memories.
   * @returns {Array<Object>} All stored memories.
   */
  getAll() {
    const results = [];
    for (const [id, entry] of this.embeddings) {
      results.push({
        id,
        text: entry.text,
        metadata: entry.metadata,
        timestamp: entry.timestamp,
      });
    }
    return results;
  }

  /**
   * Delete a memory by ID.
   * @param {string} id - The ID of the memory to delete.
   */
  deleteMemory(id) {
    this.embeddings.delete(id);
    this.save();
  }

  /**
   * Clear all memories.
   */
  clear() {
    this.embeddings.clear();
    this.save();
  }

  /**
   * Get statistics about the semantic memory.
   * @returns {Object} Statistics object.
   */
  getStats() {
    return {
      totalMemories: this.embeddings.size,
      storageSize: this.getStorageSize(),
    };
  }

  getStorageSize() {
    try {
      const filePath = path.join(this.dataDir, "embeddings.json");
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        return stats.size;
      }
    } catch (error) {
      console.warn("Failed to get storage size:", error.message);
    }
    return 0;
  }
}
