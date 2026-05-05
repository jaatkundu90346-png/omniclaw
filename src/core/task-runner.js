export class TaskRunner {
  constructor(taskStore) {
    this.taskStore = taskStore;
  }

  runTask(taskId, options = {}) {
    const agentId = typeof options === "string" ? options : options.agentId;
    const task = taskId ? this.taskStore.getTask(taskId, agentId) : this.taskStore.getLatestOpenTask(agentId);
    if (!task) {
      return {
        status: "no-task",
        message: "No open task was available to run.",
      };
    }

    const inProgress = this.taskStore.updateTask(task.id, {
      status: "in_progress",
      startedAt: new Date().toISOString(),
    });

    const checklist = this.buildChecklist(inProgress.title);
    const summary = this.buildSummary(inProgress.title, checklist);

    const completed = this.taskStore.updateTask(task.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      lastRunSummary: summary,
      checklist,
    });

    return {
      status: "completed",
      task: completed,
      summary,
      checklist,
    };
  }

  buildChecklist(title) {
    const lowered = title.toLowerCase();
    const steps = [
      "Clarify the goal and success criteria.",
      "Gather the local context and dependencies.",
      "Execute the smallest useful implementation slice.",
      "Review outputs, risks, and follow-up work.",
    ];

    if (lowered.includes("research")) {
      steps.unshift("Search the web and capture trustworthy sources.");
    }

    if (lowered.includes("build") || lowered.includes("feature")) {
      steps.push("Write or update the implementation artifacts.");
    }

    if (lowered.includes("test") || lowered.includes("verify")) {
      steps.push("Run verification and record the results.");
    }

    return steps;
  }

  buildSummary(title, checklist) {
    return `Prepared a runnable workflow for "${title}" with ${checklist.length} step(s).`;
  }
}
