/**
 * AutonomousRuntime - Orchestrates the Think-Act-Observe-Reflect (TAOR) loop.
 * Manages the autonomous execution of tasks with self-correction and adaptation.
 */

export class AutonomousRuntime {
  constructor({
    goalManager,
    planner,
    reflectionEngine,
    toolRegistry,
    semanticMemory,
    provider,
  }) {
    this.goalManager = goalManager;
    this.planner = planner;
    this.reflectionEngine = reflectionEngine;
    this.toolRegistry = toolRegistry;
    this.semanticMemory = semanticMemory;
    this.provider = provider;

    this.executionState = {
      currentGoal: null,
      currentPlan: null,
      executionHistory: [],
      reflectionLog: [],
      maxIterations: 10,
      currentIteration: 0,
    };
  }

  /**
   * Execute a task autonomously using the TAOR loop.
   * @param {string} userRequest - The user's request.
   * @param {Object} context - Execution context (tools, skills, workspace).
   * @returns {Promise<Object>} Final result of the task.
   */
  async executeTask(userRequest, context = {}) {
    try {
      // Phase 1: THINK - Initialize goal and plan
      const rootGoal = this.goalManager.createRootGoal(userRequest, context);
      this.executionState.currentGoal = rootGoal;

      // Decompose root goal into sub-goals
      const subGoals = await this.goalManager.decomposeGoal(rootGoal, context);
      rootGoal.subGoals = subGoals;

      // Main TAOR Loop
      const results = [];
      while (this.executionState.currentIteration < this.executionState.maxIterations) {
        this.executionState.currentIteration += 1;

        // Get the next pending sub-goal
        const nextSubGoal = this.goalManager.getNextSubGoal();
        if (!nextSubGoal) {
          // All sub-goals completed
          break;
        }

        // Execute TAOR cycle for this sub-goal
        const cycleResult = await this.executeTAORCycle(nextSubGoal, context);
        results.push(cycleResult);

        if (!cycleResult.success && cycleResult.shouldAbort) {
          break;
        }
      }

      // Mark root goal as completed
      this.goalManager.completeGoal(rootGoal.id, {
        subGoalsCompleted: results.length,
        results,
      });

      return {
        success: true,
        goal: rootGoal,
        results,
        executionStats: this.getExecutionStats(),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        executionStats: this.getExecutionStats(),
      };
    }
  }

  /**
   * Execute a single TAOR cycle for a sub-goal.
   * @param {Object} subGoal - The sub-goal to execute.
   * @param {Object} context - Execution context.
   * @returns {Promise<Object>} Result of the cycle.
   */
  async executeTAORCycle(subGoal, context = {}) {
    const cycleResult = {
      subGoalId: subGoal.id,
      subGoalTitle: subGoal.title,
      phases: {},
      success: false,
      shouldAbort: false,
    };

    try {
      // THINK: Generate a plan for the sub-goal
      const thinkResult = await this.thinkPhase(subGoal, context);
      cycleResult.phases.think = thinkResult;
      this.executionState.currentPlan = thinkResult.plan;

      // ACT: Execute the plan
      const actResult = await this.actPhase(thinkResult.plan, subGoal, context);
      cycleResult.phases.act = actResult;

      // OBSERVE: Collect feedback and observations
      const observeResult = this.observePhase(actResult, subGoal, context);
      cycleResult.phases.observe = observeResult;

      // REFLECT: Analyze outcomes and generate corrective actions
      const reflectResult = await this.reflectPhase(actResult, observeResult, subGoal, context);
      cycleResult.phases.reflect = reflectResult;

      // Determine if the sub-goal is achieved
      if (reflectResult.goalAchieved) {
        this.goalManager.completeGoal(subGoal.id, actResult);
        cycleResult.success = true;
      } else if (reflectResult.shouldRetry && this.executionState.currentIteration < this.executionState.maxIterations) {
        // Retry with corrective actions
        subGoal.status = "retrying";
      } else {
        this.goalManager.failGoal(subGoal.id, reflectResult.failureReason || "Max iterations reached");
        cycleResult.shouldAbort = true;
      }

      return cycleResult;
    } catch (error) {
      this.goalManager.failGoal(subGoal.id, error.message);
      cycleResult.shouldAbort = true;
      cycleResult.error = error.message;
      return cycleResult;
    }
  }

  /**
   * THINK Phase: Generate a plan for the current sub-goal.
   * @param {Object} subGoal - The sub-goal.
   * @param {Object} context - Execution context.
   * @returns {Promise<Object>} Plan and reasoning.
   */
  async thinkPhase(subGoal, context = {}) {
    const thinking = {
      startedAt: new Date().toISOString(),
      reasoning: "",
      plan: null,
    };

    try {
      // Query semantic memory for relevant past experiences
      let relevantMemories = [];
      if (this.semanticMemory && this.provider?.complete) {
        const embedding = await this.provider.complete([
          {
            role: "user",
            content: `Generate an embedding for: ${subGoal.title}`,
          },
        ]);
        // In a real implementation, this would use an embedder
        // relevantMemories = this.semanticMemory.search(embedding, 5, 0.7);
      }

      // Generate a plan using the planner
      const plan = await this.planner.buildPlanWithModel({
        message: subGoal.title,
        intents: [subGoal.type],
        skills: context.skills || [],
        tools: context.tools || [],
        profile: context.profile || {},
        provider: this.provider,
        relevantMemories,
      });

      thinking.plan = plan;
      thinking.reasoning = plan.summary || "Plan generated";
      thinking.completedAt = new Date().toISOString();

      return thinking;
    } catch (error) {
      thinking.error = error.message;
      thinking.completedAt = new Date().toISOString();
      throw error;
    }
  }

  /**
   * ACT Phase: Execute the plan.
   * @param {Object} plan - The plan to execute.
   * @param {Object} subGoal - The sub-goal.
   * @param {Object} context - Execution context.
   * @returns {Promise<Object>} Execution results.
   */
  async actPhase(plan, subGoal, context = {}) {
    const execution = {
      startedAt: new Date().toISOString(),
      steps: [],
      toolOutputs: [],
    };

    try {
      for (const step of plan.steps || []) {
        if (step.type === "tool") {
          const toolResult = await this.executeTool(step, context);
          execution.steps.push(toolResult);
          execution.toolOutputs.push({
            tool: step.tool,
            output: toolResult.output,
          });
        } else if (step.type === "respond") {
          execution.steps.push({
            type: "respond",
            status: "completed",
            reason: step.reason,
          });
        }
      }

      execution.completedAt = new Date().toISOString();
      execution.status = "completed";
      return execution;
    } catch (error) {
      execution.error = error.message;
      execution.status = "failed";
      execution.completedAt = new Date().toISOString();
      throw error;
    }
  }

  /**
   * Execute a single tool.
   * @param {Object} step - The tool step.
   * @param {Object} context - Execution context.
   * @returns {Promise<Object>} Tool execution result.
   */
  async executeTool(step, context = {}) {
    const result = {
      tool: step.tool,
      input: step.input || {},
      startedAt: new Date().toISOString(),
    };

    try {
      const output = await this.toolRegistry.run(step.tool, step.input, {
        agentId: context.agentId || "main",
        sessionId: context.sessionId || "",
        runId: context.runId || "",
      });

      result.output = output;
      result.status = output?.error || output?.blocked ? "failed" : "completed";
      result.completedAt = new Date().toISOString();

      return result;
    } catch (error) {
      result.error = error.message;
      result.status = "failed";
      result.completedAt = new Date().toISOString();
      throw error;
    }
  }

  /**
   * OBSERVE Phase: Collect feedback and observations.
   * @param {Object} actResult - Result from the Act phase.
   * @param {Object} subGoal - The sub-goal.
   * @param {Object} context - Execution context.
   * @returns {Object} Observations.
   */
  observePhase(actResult, subGoal, context = {}) {
    const observations = {
      timestamp: new Date().toISOString(),
      toolOutputCount: (actResult.toolOutputs || []).length,
      failedTools: (actResult.toolOutputs || []).filter((to) => to.output?.error || to.output?.blocked).length,
      successfulTools: (actResult.toolOutputs || []).filter((to) => !to.output?.error && !to.output?.blocked).length,
      toolOutputs: actResult.toolOutputs || [],
      environmentChanges: [],
    };

    return observations;
  }

  /**
   * REFLECT Phase: Analyze outcomes and generate corrective actions.
   * @param {Object} actResult - Result from the Act phase.
   * @param {Object} observations - Observations from the Observe phase.
   * @param {Object} subGoal - The sub-goal.
   * @param {Object} context - Execution context.
   * @returns {Promise<Object>} Reflection result.
   */
  async reflectPhase(actResult, observations, subGoal, context = {}) {
    const reflection = {
      timestamp: new Date().toISOString(),
      goalAchieved: false,
      shouldRetry: false,
      failureReason: "",
      analysis: null,
      correctiveActions: [],
    };

    try {
      // Analyze each tool output
      for (const toolOutput of observations.toolOutputs || []) {
        const analysis = await this.reflectionEngine.analyzeOutcome(
          { tool: toolOutput.tool },
          toolOutput.output,
          { goal: subGoal.title }
        );

        reflection.analysis = analysis;

        if (!analysis.success) {
          reflection.shouldRetry = true;
          const correctiveActions = await this.reflectionEngine.generateCorrectiveActions(analysis, context);
          reflection.correctiveActions.push(...correctiveActions);
        } else {
          // Learn from success
          await this.reflectionEngine.learnFromSuccess(
            { tool: toolOutput.tool },
            toolOutput.output,
            `Successfully executed ${toolOutput.tool} for goal: ${subGoal.title}`
          );
        }
      }

      // Determine if goal is achieved
      if (observations.failedTools === 0 && observations.successfulTools > 0) {
        reflection.goalAchieved = true;
      } else if (observations.failedTools > 0) {
        reflection.shouldRetry = true;
        reflection.failureReason = `${observations.failedTools} tool(s) failed`;
      }

      this.executionState.reflectionLog.push(reflection);
      return reflection;
    } catch (error) {
      reflection.error = error.message;
      return reflection;
    }
  }

  /**
   * Get execution statistics.
   * @returns {Object} Statistics about the execution.
   */
  getExecutionStats() {
    const goalStats = this.goalManager.getStats();
    return {
      ...goalStats,
      currentIteration: this.executionState.currentIteration,
      maxIterations: this.executionState.maxIterations,
      reflectionCount: this.executionState.reflectionLog.length,
      executionHistoryLength: this.executionState.executionHistory.length,
    };
  }
}
