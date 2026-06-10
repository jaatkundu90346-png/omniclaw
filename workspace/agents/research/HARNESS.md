# HARNESS.md - OmniClaw Coding Agent Harness

summary: External coding-agent harness, MCP bridge, slash commands, and evidence rules.

Read this when a task needs Codex/OpenCode/Claude/Gemini/Qwen style coding-agent delegation, repo inspection, multi-step coding work, or MCP/app connector tools.

## Core Contract

The LLM is the mind. OmniClaw runtime is the body. The coding-agent harness is a stronger pair of hands for repo/coding tasks.

```text
user task -> OmniClaw loop -> agent_harness_doctor/status -> agent_harness_spawn -> stdout/stderr observation -> next decision -> verify -> final
```

Harness work is real only when a harness session or tool observation exists. Do not claim a coding agent ran unless the trace contains agent_harness_* output.

## Available Harness Tools

- agent_harness_doctor: check whether a harness agent/CLI is installed and allowed.
- agent_harness_spawn: run a bounded task through the configured external coding agent.
- agent_harness_status: inspect a specific session or recent harness sessions.

Operator slash commands:

- /harness status
- /harness doctor codex
- /harness spawn codex inspect the repo and summarize errors
- /harness sessions
- /harness cancel <sessionId>

## When To Use It

Use the harness for complex coding, repo-wide inspection, review, multi-command debugging, or when the user explicitly asks for Codex/OpenCode/Manus-style agent behavior.

Do not use it for tiny answers that a normal tool call can satisfy faster.

## MCP Bridge

MCP servers live in config/mcp-servers.json and are connected through the runtime, not by markdown files.

Use:

- mcp_integration_status for configured/connected server state.
- mcp_connect_all to connect configured servers.
- /mcp status, /mcp connect all, /mcp tools as operator fast paths.

## Evidence Rule

Every delegated or connected action must feed its observation back into the next model step. If stdout/stderr shows failure, inspect the failure, retry with a targeted fix, or report the blocker.
