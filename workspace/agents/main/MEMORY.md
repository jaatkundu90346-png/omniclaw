# MEMORY

Durable facts, preferences, decisions, and action boundaries.

## Runtime Decisions

- OmniClaw main agent has a coding-agent harness. Use `agent_harness_doctor`, `agent_harness_spawn`, and `agent_harness_status` for real external coding-agent delegation, and inspect stdout/stderr before final.
- OmniClaw exposes MCP/app connector state through `mcp_integration_status`, `mcp_connect_all`, and `/mcp` slash commands. Markdown files describe the behavior; runtime tools prove it.
