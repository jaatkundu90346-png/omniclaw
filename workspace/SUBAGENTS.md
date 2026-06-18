# SUBAGENTS.md - OmniClaw Shared Sub-Agents

summary: Background child agent runs, delegation, announcements, and nested orchestration.

Sub-agents are background agent runs spawned from an existing run. They should run in their own session, stay isolated by default, and announce results back to the requester.

## Core Rules

- Use sub-agents for parallel research, long tasks, slow tools, and independent implementation.
- Default context mode is `isolated`.
- Use `fork` only when the child truly needs current transcript/tool context.
- Spawning is non-blocking; return a child run id immediately.
- Completion is push-based; do not poll in loops just to wait.
- Parent must review child output before claiming the original task is done.

## Tool Policy

Sub-agents should not receive session-control tools by default.

- Depth 0 main: can spawn.
- Depth 1 leaf: no session tools by default.
- Depth 1 orchestrator: may manage children when nesting is allowed.
- Depth 2 leaf: cannot spawn further.

Use max depth, max children, and global concurrency caps.

## Runtime Shape

```text
parent task -> spawn child -> child session work -> announce -> parent review -> final
```

If no real subagent tool ran, do not claim a child worked.
