/**
 * DeepResearchAgent - An autonomous research agent for OmniClaw.
 * This agent performs multi-step, iterative research with cross-referencing.
 */

export class DeepResearchAgent {
  constructor({ webResearch, toolRegistry, provider }) {
    this.webResearch = webResearch;
    this.toolRegistry = toolRegistry;
    this.provider = provider;
    this.researchHistory = [];
    this.maxIterations = 5;
    this.sourceCache = new Map();
  }

  /**
   * Perform deep research on a topic.
   * @param {string} topic - The research topic.
   * @param {number} depth - Research depth (1-5).
   * @returns {Promise<Object>} Research findings.
   */
  async research(topic, depth = 3) {
    const findings = {
      topic,
      depth,
      startedAt: new Date().toISOString(),
      iterations: [],
      synthesis: "",
      sources: [],
      confidence: 0,
    };

    let currentQuery = topic;
    let iteration = 0;

    while (iteration < Math.min(depth, this.maxIterations)) {
      const result = await this.executeResearchIteration(currentQuery, iteration);
      findings.iterations.push(result);

      if (result.followUpQuery) {
        currentQuery = result.followUpQuery;
      } else {
        break;
      }

      iteration++;
    }

    findings.synthesis = await this.synthesizeFindings(findings.iterations);
    findings.sources = this.extractUniqueSources(findings.iterations);
    findings.confidence = this.calculateConfidence(findings.iterations);
    findings.completedAt = new Date().toISOString();

    return findings;
  }

  /**
   * Execute a single research iteration.
   * @param {string} query - The search query.
   * @param {number} iteration - Iteration number.
   * @returns {Promise<Object>} Iteration results.
   */
  async executeResearchIteration(query, iteration) {
    const result = {
      iteration,
      query,
      timestamp: new Date().toISOString(),
      results: [],
      followUpQuery: null,
      analysis: "",
    };

    try {
      const searchResults = await this.webResearch.search(query, { limit: 5 });
      result.results = searchResults;

      const analysis = await this.analyzeResults(searchResults, query);
      result.analysis = analysis.summary;
      result.followUpQuery = analysis.followUpQuery;

      this.researchHistory.push(result);
    } catch (error) {
      result.error = error.message;
    }

    return result;
  }

  /**
   * Analyze search results and determine if follow-up research is needed.
   * @param {Array<Object>} results - Search results.
   * @param {string} originalQuery - Original query.
   * @returns {Promise<Object>} Analysis with follow-up query.
   */
  async analyzeResults(results, originalQuery) {
    const summaries = results.map((r) => `- ${r.title}: ${r.snippet}`).join("\n");

    const prompt = `Analyze these search results for the query "${originalQuery}":

${summaries}

Provide:
1. A brief summary of key findings
2. Any contradictions or gaps in the information
3. A follow-up query if more research is needed, or null if sufficient

Respond in JSON format: { "summary": "...", "followUpQuery": "..." or null }`;

    try {
      const response = await this.provider.respond({
        messages: [{ role: "user", content: prompt }],
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.warn("Failed to analyze results:", error.message);
    }

    return { summary: "Analysis failed", followUpQuery: null };
  }

  /**
   * Synthesize findings from all iterations.
   * @param {Array<Object>} iterations - All research iterations.
   * @returns {Promise<string>} Synthesized findings.
   */
  async synthesizeFindings(iterations) {
    const allAnalyses = iterations.map((it) => it.analysis).join("\n\n");

    const prompt = `Synthesize these research findings into a coherent summary:

${allAnalyses}

Provide a clear, well-structured summary that:
1. Identifies the main conclusions
2. Highlights any conflicting information
3. Rates the overall confidence in the findings
4. Suggests areas for further research`;

    try {
      const response = await this.provider.respond({
        messages: [{ role: "user", content: prompt }],
      });
      return response;
    } catch (error) {
      console.warn("Failed to synthesize findings:", error.message);
      return "Synthesis failed";
    }
  }

  /**
   * Extract unique sources from all iterations.
   * @param {Array<Object>} iterations - All research iterations.
   * @returns {Array<Object>} Unique sources.
   */
  extractUniqueSources(iterations) {
    const sources = new Map();

    for (const iteration of iterations) {
      for (const result of iteration.results) {
        if (result.url && !sources.has(result.url)) {
          sources.set(result.url, {
            url: result.url,
            title: result.title,
            snippet: result.snippet,
          });
        }
      }
    }

    return Array.from(sources.values());
  }

  /**
   * Calculate confidence score based on source consistency.
   * @param {Array<Object>} iterations - All research iterations.
   * @returns {number} Confidence score (0-100).
   */
  calculateConfidence(iterations) {
    if (iterations.length === 0) return 0;

    let score = 50;
    const sourceCount = this.extractUniqueSources(iterations).length;

    if (sourceCount >= 5) score += 25;
    if (sourceCount >= 10) score += 15;
    if (iterations.length >= 3) score += 10;

    return Math.min(100, score);
  }

  /**
   * Get research history.
   * @returns {Array<Object>} All research iterations.
   */
  getHistory() {
    return this.researchHistory;
  }

  /**
   * Clear research history.
   */
  clearHistory() {
    this.researchHistory = [];
    this.sourceCache.clear();
  }
}
