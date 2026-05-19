/**
 * GoalManager - Hierarchical goal decomposition and management.
 * Breaks down high-level user requests into actionable sub-goals.
 */

export class GoalManager {
  constructor({ provider, semanticMemory }) {
    this.provider = provider;
    this.semanticMemory = semanticMemory;
    this.goalStack = [];
    this.completedGoals = [];
    this.goalHistory = [];
  }

  /**
   * Create a root goal from a user request.
   * @param {string} userRequest - The user's request.
   * @param {Object} context - Additional context (intents, tools, etc.).
   * @returns {Object} The root goal object.
   */
  createRootGoal(userRequest, context = {}) {
    const rootGoal = {
      id: `goal_${Date.now()}_root`,
      type: "root",
      title: userRequest,
      description: userRequest,
      status: "active",
      priority: 1,
      createdAt: new Date().toISOString(),
      context,
      subGoals: [],
      parentGoalId: null,
    };

    this.goalStack.push(rootGoal);
    this.goalHistory.push(rootGoal);

    return rootGoal;
  }

  /**
   * Decompose a goal into sub-goals using LLM reasoning.
   * @param {Object} goal - The goal to decompose.
   * @param {Object} context - Available tools, skills, and workspace context.
   * @returns {Promise<Array>} Array of sub-goals.
   */
  async decomposeGoal(goal, context = {}) {
    if (!this.provider || typeof this.provider.complete !== "function") {
      return this.decomposeGoalHeuristic(goal, context);
    }

    try {
      const prompt = this.buildDecompositionPrompt(goal, context);
      const messages = [
        {
          role: "system",
          content: "You are a task decomposition expert. Break down complex goals into smaller, actionable sub-goals. Return a JSON array of sub-goals.",
        },
        {
          role: "user",
          content: prompt,
        },
      ];

      const response = await this.provider.complete(messages);
      const subGoals = this.parseSubGoalsFromResponse(response?.text || "", goal);

      return subGoals;
    } catch (error) {
      console.warn("LLM-based decomposition failed, falling back to heuristic:", error.message);
      return this.decomposeGoalHeuristic(goal, context);
    }
  }

  /**
   * Heuristic-based goal decomposition (fallback).
   * @param {Object} goal - The goal to decompose.
   * @param {Object} context - Available context.
   * @returns {Array} Array of sub-goals.
   */
  decomposeGoalHeuristic(goal, context = {}) {
    const subGoals = [];
    const title = (goal.title || "").toLowerCase();

    // Research-related goals
    if (title.includes("research") || title.includes("find") || title.includes("search")) {
      subGoals.push({
        id: `goal_${Date.now()}_1`,
        type: "research",
        title: "Search for relevant information",
        priority: 1,
        parentGoalId: goal.id,
        status: "pending",
      });
      subGoals.push({
        id: `goal_${Date.now()}_2`,
        type: "analysis",
        title: "Analyze and synthesize findings",
        priority: 2,
        parentGoalId: goal.id,
        status: "pending",
      });
    }

    // Code/build-related goals
    if (title.includes("build") || title.includes("code") || title.includes("implement")) {
      subGoals.push({
        id: `goal_${Date.now()}_1`,
        type: "planning",
        title: "Plan the implementation",
        priority: 1,
        parentGoalId: goal.id,
        status: "pending",
      });
      subGoals.push({
        id: `goal_${Date.now()}_2`,
        type: "execution",
        title: "Execute the implementation",
        priority: 2,
        parentGoalId: goal.id,
        status: "pending",
      });
      subGoals.push({
        id: `goal_${Date.now()}_3`,
        type: "testing",
        title: "Test and verify the result",
        priority: 3,
        parentGoalId: goal.id,
        status: "pending",
      });
    }

    // Browser/web-related goals
    if (title.includes("browse") || title.includes("web") || title.includes("visit")) {
      subGoals.push({
        id: `goal_${Date.now()}_1`,
        type: "navigation",
        title: "Navigate to the target URL",
        priority: 1,
        parentGoalId: goal.id,
        status: "pending",
      });
      subGoals.push({
        id: `goal_${Date.now()}_2`,
        type: "observation",
        title: "Observe and extract information",
        priority: 2,
        parentGoalId: goal.id,
        status: "pending",
      });
    }

    // If no specific pattern matched, create a generic sub-goal
    if (subGoals.length === 0) {
      subGoals.push({
        id: `goal_${Date.now()}_1`,
        type: "generic",
        title: `Execute: ${goal.title}`,
        priority: 1,
        parentGoalId: goal.id,
        status: "pending",
      });
    }

    return subGoals;
  }

  /**
   * Parse sub-goals from LLM response.
   * @param {string} responseText - The LLM response text.
   * @param {Object} parentGoal - The parent goal.
   * @returns {Array} Array of parsed sub-goals.
   */
  parseSubGoalsFromResponse(responseText, parentGoal) {
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return this.decomposeGoalHeuristic(parentGoal);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const subGoals = Array.isArray(parsed)
        ? parsed.map((sg, index) => ({
            id: `goal_${Date.now()}_${index}`,
            type: sg.type || "task",
            title: sg.title || sg.description || "Subtask",
            description: sg.description || "",
            priority: sg.priority || index + 1,
            parentGoalId: parentGoal.id,
            status: "pending",
          }))
        : this.decomposeGoalHeuristic(parentGoal);

      return subGoals;
    } catch (error) {
      console.warn("Failed to parse sub-goals from response, using heuristic fallback:", error.message);
      return this.decomposeGoalHeuristic(parentGoal);
    }
  }

  /**
   * Build a decomposition prompt for the LLM.
   * @param {Object} goal - The goal to decompose.
   * @param {Object} context - Available context.
   * @returns {string} The prompt.
   */
  buildDecompositionPrompt(goal, context = {}) {
    const tools = Array.isArray(context.tools) ? context.tools.map((t) => t.id).join(", ") : "unknown";
    const skills = Array.isArray(context.skills) ? context.skills.map((s) => s.id).join(", ") : "none";

    return `
Break down the following goal into 2-5 actionable sub-goals:

Goal: ${goal.title}
Description: ${goal.description || goal.title}

Available Tools: ${tools}
Available Skills: ${skills}

Return a JSON array with each sub-goal having: type, title, description, and priority (1=highest).
Example format:
[
  { "type": "research", "title": "Search for X", "description": "Use web_research to find...", "priority": 1 },
  { "type": "analysis", "title": "Analyze findings", "description": "Synthesize the results", "priority": 2 }
]
`;
  }

  /**
   * Get the current active goal.
   * @returns {Object|null} The current goal or null.
   */
  getCurrentGoal() {
    return this.goalStack.length > 0 ? this.goalStack[this.goalStack.length - 1] : null;
  }

  /**
   * Get the next pending sub-goal.
   * @returns {Object|null} The next pending sub-goal or null.
   */
  getNextSubGoal() {
    const currentGoal = this.getCurrentGoal();
    if (!currentGoal || !Array.isArray(currentGoal.subGoals)) {
      return null;
    }

    return currentGoal.subGoals.find((sg) => sg.status === "pending") || null;
  }

  /**
   * Mark a goal as completed.
   * @param {string} goalId - The goal ID.
   * @param {Object} result - The result of completing the goal.
   */
  completeGoal(goalId, result = {}) {
    const goal = this.goalHistory.find((g) => g.id === goalId);
    if (goal) {
      goal.status = "completed";
      goal.completedAt = new Date().toISOString();
      goal.result = result;
      this.completedGoals.push(goal);
    }
  }

  /**
   * Mark a goal as failed.
   * @param {string} goalId - The goal ID.
   * @param {string} reason - The reason for failure.
   */
  failGoal(goalId, reason = "") {
    const goal = this.goalHistory.find((g) => g.id === goalId);
    if (goal) {
      goal.status = "failed";
      goal.failedAt = new Date().toISOString();
      goal.failureReason = reason;
    }
  }

  /**
   * Get goal statistics.
   * @returns {Object} Statistics about goals.
   */
  getStats() {
    return {
      totalGoals: this.goalHistory.length,
      completedGoals: this.completedGoals.length,
      activeGoals: this.goalStack.length,
      completionRate: this.goalHistory.length > 0
        ? (this.completedGoals.length / this.goalHistory.length * 100).toFixed(2) + "%"
        : "0%",
    };
  }
}
