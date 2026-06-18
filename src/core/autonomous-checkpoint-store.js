/**
 * AutonomousCheckpointStore - Persist autonomous task state for recovery.
 * Enables checkpointing and resumption of long-running autonomous tasks.
 */

import fs from "node:fs";
import path from "node:path";

function createCheckpointId(prefix = "checkpoint") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class AutonomousCheckpointStore {
  constructor({ rootDir }) {
    this.rootDir = rootDir || process.cwd();
    this.checkpointDir = path.join(this.rootDir, "data", "autonomous", "checkpoints");
    this.indexFile = path.join(this.checkpointDir, "index.json");
    this.ensureDirectories();
  }

  ensureDirectories() {
    fs.mkdirSync(this.checkpointDir, { recursive: true });
    if (!fs.existsSync(this.indexFile)) {
      fs.writeFileSync(this.indexFile, JSON.stringify({ checkpoints: [], lastCleanup: null }, null, 2));
    }
  }

  readIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
    } catch {
      return { checkpoints: [], lastCleanup: null };
    }
  }

  writeIndex(data) {
    fs.writeFileSync(this.indexFile, JSON.stringify(data, null, 2));
  }

  /**
   * Save a checkpoint for an autonomous task.
   * @param {string} taskId - Unique task identifier
   * @param {Object} state - Execution state to checkpoint
   * @param {Object} metadata - Additional metadata (goal, progress, etc.)
   * @returns {Object} Checkpoint info
   */
  saveCheckpoint(taskId, state, metadata = {}) {
    const checkpointId = createCheckpointId("autonomous");
    const timestamp = new Date().toISOString();

    const checkpoint = {
      id: checkpointId,
      taskId,
      timestamp,
      state: this.serializeState(state),
      metadata: {
        goalTitle: metadata.goalTitle || "",
        currentIteration: metadata.currentIteration || 0,
        maxIterations: metadata.maxIterations || 50,
        progress: metadata.progress || 0,
        subGoalsCompleted: metadata.subGoalsCompleted || 0,
        totalSubGoals: metadata.totalSubGoals || 0,
        lastTool: metadata.lastTool || "",
        errors: metadata.errors || [],
        ...metadata,
      },
    };

    // Save checkpoint file
    const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.json`);
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

    // Update index
    const index = this.readIndex();
    // Remove old checkpoint for this taskId if exists
    index.checkpoints = index.checkpoints.filter(c => c.taskId !== taskId);
    index.checkpoints.push({
      id: checkpointId,
      taskId,
      timestamp,
      progress: metadata.progress || 0,
    });
    this.writeIndex(index);

    return {
      saved: true,
      checkpointId,
      checkpointPath,
      taskId,
      timestamp,
    };
  }

  /**
   * Load the latest checkpoint for a task.
   * @param {string} taskId - Task identifier
   * @returns {Object|null} Checkpoint data or null
   */
  loadCheckpoint(taskId) {
    const index = this.readIndex();
    const entry = index.checkpoints.find(c => c.taskId === taskId);

    if (!entry) {
      return null;
    }

    const checkpointPath = path.join(this.checkpointDir, `${entry.id}.json`);
    if (!fs.existsSync(checkpointPath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      return this.deserializeState(data);
    } catch {
      return null;
    }
  }

  /**
   * List all checkpoints.
   * @param {number} limit - Max number to return
   * @returns {Array} List of checkpoint summaries
   */
  listCheckpoints(limit = 20) {
    const index = this.readIndex();
    return index.checkpoints
      .slice(-limit)
      .reverse()
      .map(entry => ({
        id: entry.id,
        taskId: entry.taskId,
        timestamp: entry.timestamp,
        progress: entry.progress || 0,
        path: path.join(this.checkpointDir, `${entry.id}.json`),
      }));
  }

  /**
   * Delete a checkpoint.
   * @param {string} taskId - Task identifier
   * @returns {Object} Deletion result
   */
  deleteCheckpoint(taskId) {
    const index = this.readIndex();
    const entry = index.checkpoints.find(c => c.taskId === taskId);

    if (!entry) {
      return { deleted: false, reason: "not_found" };
    }

    const checkpointPath = path.join(this.checkpointDir, `${entry.id}.json`);
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath);
    }

    index.checkpoints = index.checkpoints.filter(c => c.taskId !== taskId);
    this.writeIndex(index);

    return { deleted: true, taskId };
  }

  /**
   * Clean up old checkpoints (older than maxAgeMs).
   * @param {number} maxAgeMs - Max age in milliseconds (default: 7 days)
   * @returns {Object} Cleanup results
   */
  cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const index = this.readIndex();
    const toDelete = [];
    const toKeep = [];

    for (const entry of index.checkpoints) {
      const timestamp = new Date(entry.timestamp).getTime();
      if (timestamp < cutoff) {
        toDelete.push(entry);
      } else {
        toKeep.push(entry);
      }
    }

    for (const entry of toDelete) {
      const checkpointPath = path.join(this.checkpointDir, `${entry.id}.json`);
      if (fs.existsSync(checkpointPath)) {
        fs.unlinkSync(checkpointPath);
      }
    }

    index.checkpoints = toKeep;
    index.lastCleanup = new Date().toISOString();
    this.writeIndex(index);

    return {
      cleaned: toDelete.length,
      kept: toKeep.length,
      cutoff: new Date(cutoff).toISOString(),
    };
  }

  /**
   * Serialize state for storage (remove non-serializable parts).
   */
  serializeState(state) {
    if (!state) return {};

    const serialized = {
      currentGoal: state.currentGoal ? {
        id: state.currentGoal.id,
        title: state.currentGoal.title,
        status: state.currentGoal.status,
        subGoals: (state.currentGoal.subGoals || []).map(sg => ({
          id: sg.id,
          title: sg.title,
          status: sg.status,
        })),
      } : null,
      currentPlan: state.currentPlan ? {
        summary: state.currentPlan.summary,
        steps: (state.currentPlan.steps || []).map(s => ({
          type: s.type,
          tool: s.tool,
          status: s.status,
        })),
      } : null,
      currentIteration: state.currentIteration || 0,
      maxIterations: state.maxIterations || 50,
      executionHistory: (state.executionHistory || []).slice(-50), // Keep last 50
      reflectionLog: (state.reflectionLog || []).slice(-50),
    };

    return serialized;
  }

  /**
   * Deserialize state from storage.
   */
  deserializeState(data) {
    if (!data || !data.state) return null;

    return {
      currentGoal: data.state.currentGoal,
      currentPlan: data.state.currentPlan,
      currentIteration: data.state.currentIteration,
      maxIterations: data.state.maxIterations,
      executionHistory: data.state.executionHistory || [],
      reflectionLog: data.state.reflectionLog || [],
      metadata: data.metadata,
      timestamp: data.timestamp,
    };
  }

  /**
   * Get checkpoint statistics.
   */
  getStats() {
    const index = this.readIndex();
    const checkpoints = index.checkpoints;
    const totalSize = checkpoints.reduce((sum, entry) => {
      const checkpointPath = path.join(this.checkpointDir, `${entry.id}.json`);
      if (fs.existsSync(checkpointPath)) {
        return sum + fs.statSync(checkpointPath).size;
      }
      return sum;
    }, 0);

    return {
      total: checkpoints.length,
      totalSizeBytes: totalSize,
      oldest: checkpoints[0]?.timestamp || null,
      newest: checkpoints[checkpoints.length - 1]?.timestamp || null,
      lastCleanup: index.lastCleanup,
    };
  }
}

export default AutonomousCheckpointStore;