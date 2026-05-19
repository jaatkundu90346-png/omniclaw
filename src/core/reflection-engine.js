/**
 * ReflectionEngine - LLM-powered analysis and self-correction.
 * Analyzes tool outputs, identifies failures, and proposes corrective actions.
 */

export class ReflectionEngine {
  constructor({ provider, semanticMemory, tools }) {
    this.provider = provider;
    this.semanticMemory = semanticMemory;
    this.tools = tools;
    this.reflectionHistory = [];
  }

  /**
   * Analyze the outcome of an action and determine if it was successful.
   * @param {Object} action - The action that was executed.
   * @param {Object} outcome - The outcome/result of the action.
   * @param {Object} context - Additional context (goal, plan, etc.).
   * @returns {Promise<Object>} Analysis result with success/failure determination.
   */
  async analyzeOutcome(action, outcome, context = {}) {
    const analysis = {
      action,
      outcome,
      timestamp: new Date().toISOString(),
      success: this.determineSuccess(action, outcome),
      confidence: 0.5,
      reasoning: "",
      recommendations: [],
    };

    if (!this.provider || typeof this.provider.complete !== "function") {
      return this.analyzeOutcomeHeuristic(analysis);
    }

    try {
      const prompt = this.buildAnalysisPrompt(action, outcome, context);
      const messages = [
        {
          role: "system",
          content: "You are an expert at analyzing action outcomes and providing corrective recommendations. Be concise and actionable.",
        },
        {
          role: "user",
          content: prompt,
        },
      ];

      const response = await this.provider.complete(messages);
      const parsed = this.parseAnalysisResponse(response?.text || "", analysis);

      return parsed;
    } catch (error) {
      console.warn("LLM-based analysis failed, using heuristic:", error.message);
      return this.analyzeOutcomeHeuristic(analysis);
    }
  }

  /**
   * Determine if an action was successful based on its outcome.
   * @param {Object} action - The action.
   * @param {Object} outcome - The outcome.
   * @returns {boolean} True if successful, false otherwise.
   */
  determineSuccess(action, outcome) {
    if (!outcome) return false;
    if (outcome.error || outcome.blocked) return false;
    if (outcome.success === false) return false;
    if (outcome.status === "failed") return false;

    return true;
  }

  /**
   * Heuristic-based outcome analysis (fallback).
   * @param {Object} analysis - The analysis object.
   * @returns {Object} Enhanced analysis.
   */
  analyzeOutcomeHeuristic(analysis) {
    const { action, outcome } = analysis;

    if (!analysis.success) {
      analysis.confidence = 0.9;
      analysis.reasoning = "Action failed based on error or blocked status.";

      if (outcome?.error) {
        analysis.recommendations.push({
          type: "retry",
          description: `Retry the action with adjusted parameters. Error: ${outcome.error}`,
          priority: 1,
        });
      }

      if (outcome?.blocked) {
        analysis.recommendations.push({
          type: "permission",
          description: "Action was blocked. Check permissions or constraints.",
          priority: 1,
        });
      }
    } else {
      analysis.confidence = 0.8;
      analysis.reasoning = "Action completed successfully based on available signals.";
      analysis.recommendations.push({
        type: "continue",
        description: "Proceed to the next step in the plan.",
        priority: 1,
      });
    }

    return analysis;
  }

  /**
   * Parse analysis response from LLM.
   * @param {string} responseText - The LLM response.
   * @param {Object} analysis - The analysis object to populate.
   * @returns {Object} Parsed analysis.
   */
  parseAnalysisResponse(responseText, analysis) {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.analyzeOutcomeHeuristic(analysis);
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.success !== undefined) {
        analysis.success = Boolean(parsed.success);
      }
      if (parsed.confidence !== undefined) {
        analysis.confidence = Math.min(1, Math.max(0, Number(parsed.confidence)));
      }
      if (parsed.reasoning) {
        analysis.reasoning = String(parsed.reasoning);
      }
      if (Array.isArray(parsed.recommendations)) {
        analysis.recommendations = parsed.recommendations.map((rec) => ({
          type: rec.type || "generic",
          description: rec.description || "",
          priority: rec.priority || 2,
        }));
      }

      return analysis;
    } catch (error) {
      console.warn("Failed to parse analysis response, using heuristic:", error.message);
      return this.analyzeOutcomeHeuristic(analysis);
    }
  }

  /**
   * Build an analysis prompt for the LLM.
   * @param {Object} action - The action.
   * @param {Object} outcome - The outcome.
   * @param {Object} context - Additional context.
   * @returns {string} The prompt.
   */
  buildAnalysisPrompt(action, outcome, context = {}) {
    return `
Analyze the following action and its outcome:

Action: ${action.tool || action.type || "unknown"}
Input: ${JSON.stringify(action.input || {})}

Outcome:
${JSON.stringify(outcome, null, 2)}

Context:
Goal: ${context.goal || "unknown"}
Plan: ${context.plan || "unknown"}

Respond with a JSON object containing:
- success (boolean): Was the action successful?
- confidence (0-1): How confident are you in this assessment?
- reasoning (string): Brief explanation of your assessment.
- recommendations (array): List of {type, description, priority} for next steps.

Example:
{
  "success": true,
  "confidence": 0.95,
  "reasoning": "The tool executed successfully and returned expected data.",
  "recommendations": [
    { "type": "continue", "description": "Proceed to the next step.", "priority": 1 }
  ]
}
`;
  }

  /**
   * Generate corrective actions based on analysis.
   * @param {Object} analysis - The analysis result.
   * @param {Object} context - Additional context.
   * @returns {Promise<Array>} Array of corrective actions.
   */
  async generateCorrectiveActions(analysis, context = {}) {
    const actions = [];

    if (analysis.success) {
      actions.push({
        type: "continue",
        description: "Proceed with the current plan.",
        priority: 1,
      });
    } else {
      // Add recommendations from analysis
      if (Array.isArray(analysis.recommendations)) {
        actions.push(...analysis.recommendations);
      }

      // Generate additional corrective actions
      if (!this.provider || typeof this.provider.complete !== "function") {
        return this.generateCorrectiveActionsHeuristic(analysis, context);
      }

      try {
        const prompt = this.buildCorrectionPrompt(analysis, context);
        const messages = [
          {
            role: "system",
            content: "You are an expert at generating corrective actions for failed tasks.",
          },
          {
            role: "user",
            content: prompt,
          },
        ];

        const response = await this.provider.complete(messages);
        const parsed = this.parseCorrectionResponse(response?.text || "", analysis);

        return parsed;
      } catch (error) {
        console.warn("LLM-based correction generation failed:", error.message);
        return this.generateCorrectiveActionsHeuristic(analysis, context);
      }
    }

    return actions;
  }

  /**
   * Heuristic-based corrective action generation (fallback).
   * @param {Object} analysis - The analysis.
   * @param {Object} context - Additional context.
   * @returns {Array} Corrective actions.
   */
  generateCorrectiveActionsHeuristic(analysis, context = {}) {
    const actions = [];

    if (analysis.recommendations && analysis.recommendations.length > 0) {
      actions.push(...analysis.recommendations);
    }

    if (actions.length === 0) {
      actions.push({
        type: "retry",
        description: "Retry the action with adjusted parameters.",
        priority: 1,
      });
      actions.push({
        type: "replan",
        description: "Generate a new plan for the current goal.",
        priority: 2,
      });
    }

    return actions;
  }

  /**
   * Parse correction response from LLM.
   * @param {string} responseText - The LLM response.
   * @param {Object} analysis - The analysis.
   * @returns {Array} Parsed corrective actions.
   */
  parseCorrectionResponse(responseText, analysis) {
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return this.generateCorrectiveActionsHeuristic(analysis);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return Array.isArray(parsed)
        ? parsed.map((action) => ({
            type: action.type || "generic",
            description: action.description || "",
            priority: action.priority || 2,
          }))
        : this.generateCorrectiveActionsHeuristic(analysis);
    } catch (error) {
      console.warn("Failed to parse correction response:", error.message);
      return this.generateCorrectiveActionsHeuristic(analysis);
    }
  }

  /**
   * Build a correction prompt for the LLM.
   * @param {Object} analysis - The analysis.
   * @param {Object} context - Additional context.
   * @returns {string} The prompt.
   */
  buildCorrectionPrompt(analysis, context = {}) {
    return `
Based on the following failed action analysis, generate corrective actions:

Analysis:
${JSON.stringify(analysis, null, 2)}

Context:
Goal: ${context.goal || "unknown"}
Available Tools: ${context.tools || "unknown"}

Return a JSON array of corrective actions with: type, description, and priority (1=highest).
Example:
[
  { "type": "retry", "description": "Retry with different parameters", "priority": 1 },
  { "type": "replan", "description": "Generate a new plan", "priority": 2 }
]
`;
  }

  /**
   * Learn from successful actions and store in semantic memory.
   * @param {Object} action - The successful action.
   * @param {Object} outcome - The outcome.
   * @param {string} lesson - The lesson learned.
   */
  async learnFromSuccess(action, outcome, lesson = "") {
    if (!this.semanticMemory) {
      return;
    }

    const memory = {
      type: "success_pattern",
      action: action.tool || action.type,
      input: action.input || {},
      outcome: outcome,
      lesson: lesson || `Successfully executed ${action.tool || action.type}`,
      timestamp: new Date().toISOString(),
    };

    try {
      const embedding = await this.semanticMemory.embedder?.embed(memory.lesson);
      if (embedding) {
        this.semanticMemory.addMemory(
          `pattern_${Date.now()}`,
          JSON.stringify(memory),
          embedding,
          { type: "success_pattern", action: action.tool || action.type }
        );
      }
    } catch (error) {
      console.warn("Failed to store success pattern in semantic memory:", error.message);
    }
  }

  /**
   * Get reflection history.
   * @returns {Array} History of reflections.
   */
  getHistory() {
    return this.reflectionHistory;
  }

  /**
   * Clear reflection history.
   */
  clearHistory() {
    this.reflectionHistory = [];
  }
}
