/**
 * AutonomousDaemon - Background daemon for continuous autonomous execution.
 * Runs autonomous tasks in background, monitors health, and manages task queue.
 */

import { EventEmitter } from "node:events";

function generateId(prefix = "daemon") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class AutonomousDaemon extends EventEmitter {
  constructor({ autonomousRuntime, checkpointStore, gatewayStore }) {
    super();
    this.runtime = autonomousRuntime;
    this.checkpointStore = checkpointStore;
    this.gatewayStore = gatewayStore;

    this.running = false;
    this.taskQueue = [];
    this.activeTaskId = null;
    this.intervalMs = 30000; // Check queue every 30 seconds
    this.timer = null;
    this.stats = {
      tasksProcessed: 0,
      tasksFailed: 0,
      lastCheckAt: null,
      startedAt: null,
    };
  }

  /**
   * Start the daemon.
   */
  start() {
    if (this.running) return;

    this.running = true;
    this.stats.startedAt = new Date().toISOString();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    
    this.emit("started");
    this.gatewayStore?.addEvent("autonomous-daemon.started", {
      intervalMs: this.intervalMs,
    });

    // Run first tick immediately
    void this.tick();
  }

  /**
   * Stop the daemon.
   */
  stop() {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.emit("stopped");
    this.gatewayStore?.addEvent("autonomous-daemon.stopped", {});
  }

  /**
   * Add a task to the queue.
   * @param {Object} task - Task object with objective and context
   * @returns {string} Task ID
   */
  enqueue(task = {}) {
    const taskId = generateId("autonomous-task");
    const queueItem = {
      id: taskId,
      objective: task.objective || task.task || "",
      context: task.context || {},
      priority: task.priority || 0,
      maxIterations: Math.max(1, Math.min(10000, Number(task.maxIterations || 200))),
      addedAt: new Date().toISOString(),
      status: "queued",
    };

    // Insert by priority (higher first)
    const insertIndex = this.taskQueue.findIndex(t => t.priority < queueItem.priority);
    if (insertIndex === -1) {
      this.taskQueue.push(queueItem);
    } else {
      this.taskQueue.splice(insertIndex, 0, queueItem);
    }

    this.emit("task-enqueued", queueItem);
    this.gatewayStore?.addEvent("autonomous-daemon.task_enqueued", {
      taskId,
      queueLength: this.taskQueue.length,
    });

    return taskId;
  }

  /**
   * Cancel a queued task.
   * @param {string} taskId - Task ID
   * @returns {Object} Result
   */
  cancelTask(taskId) {
    if (this.activeTaskId === taskId) {
      // Can't cancel active task, need to implement cancellation
      return { cancelled: false, reason: "task_active" };
    }

    const index = this.taskQueue.findIndex(t => t.id === taskId);
    if (index === -1) {
      return { cancelled: false, reason: "not_found" };
    }

    this.taskQueue.splice(index, 1);
    this.gatewayStore?.addEvent("autonomous-daemon.task_cancelled", { taskId });
    return { cancelled: true, taskId };
  }

  /**
   * Main daemon tick - process queue.
   */
  async tick() {
    if (!this.running) return;

    this.stats.lastCheckAt = new Date().toISOString();

    // Skip if already processing a task
    if (this.activeTaskId && this.runtime?.executionState?.currentGoal) {
      return;
    }

    // Get next task from queue
    const task = this.taskQueue.shift();
    if (!task) {
      return;
    }

    this.activeTaskId = task.id;
    task.status = "running";
    task.startedAt = new Date().toISOString();

    this.emit("task-started", task);
    this.gatewayStore?.addEvent("autonomous-daemon.task_started", {
      taskId: task.id,
      objective: task.objective?.slice(0, 100),
    });

    try {
      // Execute the task
      const result = await this.runtime.executeTask(task.objective, {
        taskId: task.id,
        ...task.context,
        maxIterations: task.maxIterations,
        daemonMode: true,
        checkpointEnabled: true,
      });

      task.status = result.success ? "completed" : "failed";
      task.completedAt = new Date().toISOString();
      task.result = result;

      if (result.success) {
        this.stats.tasksProcessed++;
      } else {
        this.stats.tasksFailed++;
      }

      this.emit("task-completed", task);
      this.gatewayStore?.addEvent("autonomous-daemon.task_completed", {
        taskId: task.id,
        success: result.success,
        iterations: result.executionStats?.currentIteration,
      });
    } catch (error) {
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = error.message;
      this.stats.tasksFailed++;

      this.emit("task-failed", { task, error: error.message });
      this.gatewayStore?.addEvent("autonomous-daemon.task_failed", {
        taskId: task.id,
        error: error.message,
      });
    } finally {
      this.activeTaskId = null;
    }
  }

  /**
   * Get daemon status.
   */
  getStatus() {
    return {
      running: this.running,
      queueLength: this.taskQueue.length,
      activeTaskId: this.activeTaskId,
      intervalMs: this.intervalMs,
      stats: { ...this.stats },
      queue: this.taskQueue.slice(0, 10).map(t => ({
        id: t.id,
        objective: t.objective?.slice(0, 50),
        priority: t.priority,
        status: t.status,
        addedAt: t.addedAt,
      })),
    };
  }

  /**
   * Set polling interval.
   * @param {number} intervalMs - Interval in milliseconds
   */
  setInterval(intervalMs) {
    this.intervalMs = Math.max(5000, intervalMs);
    if (this.running) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  /**
   * Clear the task queue.
   */
  clearQueue() {
    const count = this.taskQueue.length;
    this.taskQueue = [];
    return { cleared: count };
  }
}

export default AutonomousDaemon;
