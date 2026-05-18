import fs from "node:fs";
import path from "node:path";

function normalizeAgentId(agentId = "") {
  const value = String(agentId || "").trim();
  return value || "main";
}

export class TaskStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "tasks.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            tasks: [],
          },
          null,
          2,
        ),
      );
    }
  }

  read() {
    return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  filterByAgent(tasks, agentId = "") {
    if (!agentId) {
      return tasks;
    }
    const normalized = normalizeAgentId(agentId);
    return tasks.filter((task) => normalizeAgentId(task.agentId) === normalized);
  }

  createTask(title, options = {}) {
    const data = this.read();
    const task = {
      id: `task_${Date.now()}`,
      title,
      agentId: normalizeAgentId(options.agentId),
      status: "open",
      objective: String(options.objective || title || "").trim(),
      sourceMessage: String(options.sourceMessage || "").trim(),
      taskType: String(options.taskType || "general").trim(),
      priority: String(options.priority || "normal").trim(),
      plan: Array.isArray(options.plan) ? options.plan : [],
      toolPlan: Array.isArray(options.toolPlan) ? options.toolPlan : [],
      acceptanceCriteria: Array.isArray(options.acceptanceCriteria) ? options.acceptanceCriteria : [],
      automation: options.automation && typeof options.automation === "object" ? options.automation : null,
      context: options.context && typeof options.context === "object" ? options.context : {},
      artifacts: [],
      runHistory: [],
      createdAt: new Date().toISOString(),
    };
    data.tasks.push(task);
    this.write(data);
    return task;
  }

  listTasks(agentId = "") {
    return this.filterByAgent(this.read().tasks, agentId);
  }

  getTask(taskId, agentId = "") {
    return this.filterByAgent(this.read().tasks, agentId).find((task) => task.id === taskId) || null;
  }

  getLatestOpenTask(agentId = "") {
    const openTasks = this.filterByAgent(this.read().tasks, agentId).filter((task) => task.status === "open");
    return openTasks.length > 0 ? openTasks[openTasks.length - 1] : null;
  }

  updateTask(taskId, updates) {
    const data = this.read();
    const index = data.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) {
      throw new Error(`Task not found: ${taskId}`);
    }

    data.tasks[index] = {
      ...data.tasks[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.tasks[index];
  }
}
