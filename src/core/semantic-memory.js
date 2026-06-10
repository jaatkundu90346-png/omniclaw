import fs from "node:fs";
import path from "node:path";

export class SimpleTextEmbedder {
  constructor({ dimensions = 256 } = {}) {
    this.dimensions = dimensions;
  }

  async embed(text = "") {
    const vector = new Array(this.dimensions).fill(0);
    const tokens = String(text || "")
      .toLowerCase()
      .match(/[a-z0-9_]{2,}/g) || [];

    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i += 1) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      vector[Math.abs(hash) % this.dimensions] += 1;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map((value) => value / norm) : vector;
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
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn("Failed to save semantic memory embeddings:", error.message);
    }
  }

  /**
   * Add a memory entry with its embedding.
   * @param {string} id - Unique identifier for the memory.
   * @param {string} text - The text content of the memory.
   * @param {Array<number>} embedding - The embedding vector.
   * @param {Object} metadata - Additional metadata.
   */
  addMemory(id, text, embedding, metadata = {}) {
    this.embeddings.set(id, {
      text,
      embedding,
      metadata,
      timestamp: new Date().toISOString(),
    });
    this.save();
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

    for (const [id, entry] of this.embeddings) {
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
