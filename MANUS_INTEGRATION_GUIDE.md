# OmniClaw Manus-Level Enhancement Integration Guide

This guide explains how to integrate the new Manus-level enhancement modules into OmniClaw's agent runtime.

## New Modules Overview

### 1. Semantic Memory (`src/core/semantic-memory.js`)

**Purpose:** Provides vector-based semantic search for long-term memory, enabling the agent to find relevant past context even when keywords don't match.

**Key Methods:**
- `addMemory(id, text, embedding, metadata)` - Store a memory with its embedding
- `search(queryEmbedding, limit, threshold)` - Find similar memories using cosine similarity
- `getAll()` - Retrieve all stored memories
- `getStats()` - Get memory statistics

**Integration Steps:**
1. Import in `src/core/agent.js`:
   ```javascript
   import { SemanticMemory } from "./semantic-memory.js";
   ```

2. Initialize in the `OmniClawAgent` constructor:
   ```javascript
   this.semanticMemory = new SemanticMemory({ rootDir: this.rootDir });
   ```

3. Initialize an embedder (e.g., using a provider's embedding API or a local model)

### 2. Deep Research Agent (`src/core/deep-research-agent.js`)

**Purpose:** Performs multi-step, iterative research with automatic follow-up queries, source synthesis, and confidence scoring.

**Key Methods:**
- `research(topic, depth)` - Execute deep research on a topic
- `executeResearchIteration(query, iteration)` - Run a single research step
- `synthesizeFindings(iterations)` - Combine findings into a coherent summary
- `extractUniqueSources(iterations)` - Collect all cited sources
- `calculateConfidence(iterations)` - Score confidence based on source diversity

**Integration Steps:**
1. Import in `src/core/agent.js`:
   ```javascript
   import { DeepResearchAgent } from "./deep-research-agent.js";
   ```

2. Initialize in the `OmniClawAgent` constructor:
   ```javascript
   this.deepResearchAgent = new DeepResearchAgent({
     webResearch: this.webResearch,
     toolRegistry: this.tools,
     provider: this.provider,
   });
   ```

### 3. Visual Browser Operator (`src/core/visual-browser-operator.js`)

**Purpose:** Enhances browser automation with vision-based element detection and interaction, allowing the agent to understand and interact with web pages visually.

**Key Methods:**
- `analyzeCurrentPage()` - Take a screenshot and detect interactive elements
- `clickByVisualDescription(description)` - Click an element by visual description
- `typeByVisualDescription(description, text)` - Type into a field by visual description
- `extractTextByVisualDescription(description)` - Extract text by visual description
- `getPageContext()` - Get full page context including screenshot and elements

**Integration Steps:**
1. Import in `src/core/agent.js`:
   ```javascript
   import { VisualBrowserOperator } from "./visual-browser-operator.js";
   ```

2. Initialize in the `OmniClawAgent` constructor:
   ```javascript
   this.visualBrowserOperator = new VisualBrowserOperator({
     browserPlaywright: this.browserPlaywright,
     visionProvider: this.provider, // Must support vision/image analysis
   });
   ```

### 4. Multi-Provider Fallback (`src/core/multi-provider-fallback.js`)

**Purpose:** Manages multiple LLM providers with automatic health checks, failover, and intelligent selection based on latency and availability.

**Key Methods:**
- `selectProvider()` - Get the best available provider
- `executeWithFallback(requestFn, options)` - Execute a request with automatic fallback
- `checkProviderHealth(provider)` - Perform a health check
- `getProviderStatus()` - Get status of all providers
- `addProvider(id, profile)` - Add a new provider to the chain
- `removeProvider(id)` - Remove a provider

**Integration Steps:**
1. Import in `src/core/agent.js`:
   ```javascript
   import { MultiProviderFallback } from "./multi-provider-fallback.js";
   ```

2. Initialize in the `OmniClawAgent` constructor:
   ```javascript
   this.multiProviderFallback = new MultiProviderFallback({
     providers: [this.provider],
     configStore: this.config,
   });
   ```

## New Tools

The `manus-tools-extension.js` module provides 9 new tools that leverage these capabilities:

1. **semantic_memory_search** - Search memory using semantic similarity
2. **deep_research** - Perform multi-step research
3. **visual_browser_click** - Click by visual description
4. **visual_browser_type** - Type by visual description
5. **visual_browser_analyze** - Analyze page visually
6. **provider_health_check** - Check provider health
7. **provider_select_best** - Select best provider
8. **semantic_memory_add** - Add to semantic memory
9. **semantic_memory_stats** - Get memory statistics

**Integration into Tool Registry:**
1. Import in `src/core/tool-registry.js`:
   ```javascript
   import { createManusTooIsExtension } from "./manus-tools-extension.js";
   ```

2. In the `ToolRegistry` constructor, register the new tools:
   ```javascript
   const manusTools = createManusTooIsExtension(agentRuntime);
   Object.assign(this.tools, manusTools);
   ```

## Configuration

Add to `config/default.json`:

```json
{
  "semanticMemory": {
    "enabled": true,
    "embeddingModel": "text-embedding-3-small",
    "similarityThreshold": 0.5,
    "maxMemories": 10000
  },
  "deepResearch": {
    "enabled": true,
    "maxIterations": 5,
    "defaultDepth": 3
  },
  "visualBrowser": {
    "enabled": true,
    "visionModel": "gpt-4-vision-preview",
    "timeout": 30000
  },
  "multiProvider": {
    "enabled": true,
    "healthCheckInterval": 60000,
    "fallbackTimeout": 5000
  }
}
```

## Usage Examples

### Semantic Memory Search
```javascript
const results = await agent.tools.semantic_memory_search.run({
  query: "machine learning best practices",
  limit: 10,
  threshold: 0.6
});
```

### Deep Research
```javascript
const research = await agent.tools.deep_research.run({
  topic: "latest developments in quantum computing",
  depth: 4
});
```

### Visual Browser Interaction
```javascript
await agent.tools.visual_browser_click.run({
  description: "blue Submit button in the login form"
});

await agent.tools.visual_browser_type.run({
  description: "email input field",
  text: "user@example.com"
});
```

### Provider Management
```javascript
const status = await agent.tools.provider_health_check.run({});
const best = await agent.tools.provider_select_best.run({});
```

## Testing

Create a test file `test/manus-enhancements.test.js`:

```javascript
import { SemanticMemory } from "../src/core/semantic-memory.js";
import { DeepResearchAgent } from "../src/core/deep-research-agent.js";
import { VisualBrowserOperator } from "../src/core/visual-browser-operator.js";
import { MultiProviderFallback } from "../src/core/multi-provider-fallback.js";

// Test semantic memory
const memory = new SemanticMemory({ rootDir: "./test-data" });
memory.addMemory("test1", "Sample memory text", [0.1, 0.2, 0.3]);
const results = memory.search([0.1, 0.2, 0.3], 10, 0.5);
console.log("Semantic memory test:", results.length > 0 ? "PASS" : "FAIL");

// Test deep research agent
// (Requires mocked webResearch and provider)

// Test visual browser operator
// (Requires mocked browserPlaywright and visionProvider)

// Test multi-provider fallback
// (Requires mocked configStore)
```

## Performance Considerations

1. **Semantic Memory:** Embeddings are computed once and cached. Search is O(n) where n is the number of memories.
2. **Deep Research:** Each iteration makes web requests. Consider rate limiting and caching.
3. **Visual Browser:** Vision model calls are expensive. Cache screenshots when possible.
4. **Multi-Provider:** Health checks are cached for 60 seconds to avoid excessive API calls.

## Next Steps

1. Implement an embedder service (local or API-based)
2. Configure vision provider for visual browser operator
3. Set up multiple LLM providers in configuration
4. Test integration with real providers
5. Add UI components for new tools
6. Create documentation for end users
