# AGENT_LOOP.md - OmniClaw Shared Loop Contract

OmniClaw agents follow a real manager loop:

```text
intake -> context -> model decision -> tool execution -> observation -> correction -> verification -> persistence -> final
```

The LLM thinks. Tools act. OmniClaw coordinates, streams progress, stores state, and enforces budgets.

## Required Events

- `agent.thinking`
- `tool.started`
- `tool.output`
- `tool.completed`
- `tool.failed`
- `agent.reviewing`
- `agent.done`

## Required Discipline

- One active run per session lane.
- Tool output must feed the next decision.
- Failed tools trigger correction or honest blocker.
- Long work uses checkpoints/background/scheduler.
- Final answers must be trace-grounded.
