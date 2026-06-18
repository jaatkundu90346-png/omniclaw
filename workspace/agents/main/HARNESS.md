# HARNESS.md - OmniClaw Main Agent Harness

summary: Coding-agent harness, MCP bridge, slash commands, and evidence rules for the main agent.

## Contract

The LLM is the mind. OmniClaw runtime is the body. Harness tools are stronger hands for coding/repo tasks.

```text
think -> agent_harness_doctor/status -> agent_harness_spawn -> observe stdout/stderr -> decide next step -> verify -> final
```

Do not claim delegated work happened unless a real `agent_harness_*` observation exists.

## Tools

- `agent_harness_doctor`: check a configured coding-agent CLI.
- `agent_harness_spawn`: run a bounded coding/repo task through the harness.
- `agent_harness_status`: inspect recent/session output before final.
- `mcp_integration_status`: inspect configured/connected MCP servers.
- `mcp_connect_all`: connect configured MCP servers.

## Slash Commands

- `/harness status`
- `/harness doctor codex`
- `/harness spawn codex inspect the repo and summarize failures`
- `/harness sessions`
- `/harness cancel <sessionId>`
- `/mcp status`
- `/mcp connect all`
- `/mcp tools`

## Evidence Rule

Harness stdout/stderr is not final by itself. Read it, reason over it, retry or verify when needed, then answer the user with what really happened.

## Strong Harness Task Fields

When calling `agent_harness_spawn`, include these fields whenever possible:

- `successCriteria`: what must be true when done.
- `verificationCommands`: commands OmniClaw should run after the child agent finishes.
- `requiredArtifacts`: files/artifacts that must exist.
- `constraints`: scope and safety rules.

The parent agent should treat `observation.status = needs_repair` as a loop signal, not as final success.
