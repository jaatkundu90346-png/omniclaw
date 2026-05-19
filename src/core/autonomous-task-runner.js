/**
 * AutonomousTaskRunner - Persistent execution of autonomous tasks.
 * Handles task state persistence and resumption.
 */

export class AutonomousTaskRunner {
  constructor({ autonomousRuntime, gatewayStore, sessionStore }) {
    this.runtime = autonomousRuntime;
    this.gateway = gatewayStore;
    this.sessions = sessionStore;
    this.activeTasks = new Map();
  }

  /**
   * Run a task autonomously and persist its state.
   * @param {string} taskId - Unique task ID.
   * @param {string} request - User request.
   * @param {Object} context - Execution context.
   * @returns {Promise<Object>} Final result.
   */
  async runTask(taskId, request, context = {}) {
    const run = this.gateway.createRun({
      sessionId: context.sessionId || "autonomous_session",
      agentId: context.agentId || "main",
      message: request,
      status: "running",
      source: "autonomous_task_runner",
    });

    this.activeTasks.set(taskId, {
      runId: run.id,
      request,
      startedAt: new Date().toISOString(),
      status: "running",
    });

    try {
      this.gateway.addEvent("task_runner.started", {
        taskId,
        runId: run.id,
        request,
      });

      const result = await this.runtime.executeTask(request, {
        ...context,
        runId: run.id,
      });

      const status = result.success ? "completed" : "failed";
      this.activeTasks.set(taskId, {
        ...this.activeTasks.get(taskId),
        status,
        completedAt: new Date().toISOString(),
        result,
      });

      this.gateway.updateRun(run.id, {
        status,
        completedAt: new Date().toISOString(),
        result,
      });

      this.gateway.addEvent("task_runner.completed", {
        taskId,
        runId: run.id,
        status,
      });

      return result;
    } catch (error) {
      this.activeTasks.set(taskId, {
        ...this.activeTasks.get(taskId),
        status: "failed",
        error: error.message,
      });

      this.gateway.updateRun(run.id, {
        status: "failed",
        error: error.message,
      });

      this.gateway.addEvent("task_runner.failed", {
        taskId,
        runId: run.id,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Get the status of an active task.
   * @param {string} taskId - Task ID.
   * @returns {Object|null} Task status.
   */
  getTaskStatus(taskId) {
    return this.activeTasks.get(taskId) || null;
  }

  /**
   * List all active tasks.
   * @returns {Array} List of active tasks.
   */
  listActiveTasks() {
    return Array.from(this.activeTasks.entries()).map(([id, task]) => ({
      id,
      ...task,
    }));
  }
}
