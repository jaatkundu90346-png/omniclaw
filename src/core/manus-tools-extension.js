/**
 * ManusTooIsExtension - Extended tool definitions for Manus-level capabilities.
 * This module adds new tools that leverage the enhanced modules.
 */

export function createManusToolsExtension(runtime) {
  return {
    semantic_memory_search: {
      description: "Search long-term memory using semantic similarity, not just keywords.",
      permission: "allowMemoryRead",
      run: async ({ query, limit = 10, threshold = 0.5 }, context) => {
        if (!runtime.semanticMemory) {
          return { error: "Semantic memory not initialized" };
        }

        try {
          const results = await runtime.semanticMemory.searchText(query, limit, threshold);
          return {
            query,
            results,
            count: results.length,
          };
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    deep_research: {
      description: "Perform deep, multi-step research on a topic with cross-referencing and synthesis.",
      permission: "allowWebResearch",
      run: async ({ topic, depth = 3 }, context) => {
        if (!runtime.deepResearchAgent) {
          return { error: "Deep research agent not initialized" };
        }

        try {
          const findings = await runtime.deepResearchAgent.research(topic, depth);
          return {
            topic,
            depth,
            findings,
            sourceCount: findings.sources.length,
            confidence: findings.confidence,
          };
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    visual_browser_click: {
      description: "Click on a browser element using visual description instead of selectors.",
      permission: "allowBrowserControl",
      run: async ({ description }, context) => {
        if (!runtime.visualBrowserOperator) {
          return { error: "Visual browser operator not initialized" };
        }

        try {
          const result = await runtime.visualBrowserOperator.clickByVisualDescription(description);
          return result;
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    visual_browser_type: {
      description: "Type text into a browser field using visual description.",
      permission: "allowBrowserControl",
      run: async ({ description, text }, context) => {
        if (!runtime.visualBrowserOperator) {
          return { error: "Visual browser operator not initialized" };
        }

        try {
          const result = await runtime.visualBrowserOperator.typeByVisualDescription(description, text);
          return result;
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    visual_browser_analyze: {
      description: "Analyze the current browser page and extract interactive elements visually.",
      permission: "allowBrowserControl",
      run: async (_, context) => {
        if (!runtime.visualBrowserOperator) {
          return { error: "Visual browser operator not initialized" };
        }

        try {
          const analysis = await runtime.visualBrowserOperator.analyzeCurrentPage();
          return {
            elements: analysis.elements,
            elementCount: analysis.elements.length,
            hasScreenshot: Boolean(analysis.screenshot),
          };
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    provider_health_check: {
      description: "Check the health and availability of configured LLM providers.",
      permission: null,
      run: async (_, context) => {
        if (!runtime.multiProviderFallback) {
          return { error: "Multi-provider fallback not initialized" };
        }

        try {
          const status = await runtime.multiProviderFallback.getProviderStatus();
          return status;
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    provider_select_best: {
      description: "Select the best available provider based on health and performance.",
      permission: null,
      run: async (_, context) => {
        if (!runtime.multiProviderFallback) {
          return { error: "Multi-provider fallback not initialized" };
        }

        try {
          const selected = await runtime.multiProviderFallback.selectProvider();
          return {
            selectedProviderId: selected.id,
            healthy: selected.health.healthy,
            latency: selected.health.latency,
          };
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    semantic_memory_add: {
      description: "Add a new entry to semantic memory with automatic embedding.",
      permission: "allowMemoryWrite",
      run: async ({ text, metadata = {} }, context) => {
        if (!runtime.semanticMemory || !runtime.embedder) {
          return { error: "Semantic memory or embedder not initialized" };
        }

        try {
          const embedding = await runtime.embedder.embed(text);
          const id = `memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          runtime.semanticMemory.addMemory(id, text, embedding, metadata);

          return {
            success: true,
            memoryId: id,
            textLength: text.length,
          };
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    semantic_memory_stats: {
      description: "Get statistics about the semantic memory system.",
      permission: null,
      run: async (_, context) => {
        if (!runtime.semanticMemory) {
          return { error: "Semantic memory not initialized" };
        }

        try {
          const stats = runtime.semanticMemory.getStats();
          return stats;
        } catch (error) {
          return { error: error.message };
        }
      },
    },

    autonomous_task: {
      description: "Run a bounded Think-Act-Observe-Reflect autonomous task loop with tool execution and reflection.",
      permission: "allowTaskRunner",
      group: "autonomy",
      run: async ({ objective, task, maxIterations = 200, daemonMode = false, checkpointEnabled = true }, context = {}) => {
        if (!runtime.autonomousRuntime) {
          return { error: "Autonomous runtime not initialized" };
        }

        const request = String(objective || task || "").trim();
        if (!request) {
          return { error: "objective is required" };
        }

        const previousMax = runtime.autonomousRuntime.executionState.maxIterations;
        runtime.autonomousRuntime.executionState.maxIterations = Math.max(1, Math.min(10000, Number(maxIterations || 200)));
        runtime.autonomousRuntime.executionState.currentIteration = 0;
        try {
          return await runtime.autonomousRuntime.executeTask(request, {
            ...context,
            daemonMode: Boolean(daemonMode),
            checkpointEnabled: checkpointEnabled !== false,
            maxIterations: Math.max(1, Math.min(10000, Number(maxIterations || 200))),
            tools: runtime.tools?.getAll?.({ agentId: context.agentId || "main", modelCallableOnly: true }) || [],
            skills: runtime.skills?.list?.() || [],
          });
        } catch (error) {
          return { error: error.message };
        } finally {
          runtime.autonomousRuntime.executionState.maxIterations = previousMax;
        }
      },
    },
  };
}

export const createManusTooIsExtension = createManusToolsExtension;
