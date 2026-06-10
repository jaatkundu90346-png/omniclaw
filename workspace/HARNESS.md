# HARNESS.md - OmniClaw Shared Harness Manual

Coding-agent harness and MCP are runtime bridges, not markdown-only features.

Use harness when a real task benefits from an external coding agent such as Codex/OpenCode/Claude/Gemini/Qwen. Use MCP when a configured app/server connector provides tools.

The loop stays the same:

```text
model decides -> runtime executes -> observation returns -> model decides again
```

Never finalize from a promise. Finalize from observations.
