# SUBAGENTS.md - OmniClaw Sub-Agents

summary: Spawn isolated background agent runs, delegate work, and announce results back to the requester session.

## Core Idea

Sub-agents are background agent runs spawned from an existing run. They should run in their own session, stay isolated by default, and announce results back to the requester session when finished.

Primary goals:

- parallelize research, long tasks, slow tools, and independent implementation work
- keep main session responsive
- isolate child context and tool permissions
- support orchestrator patterns with bounded nesting

## Context Modes

- isolated: clean child transcript. Default for independent tasks.
- fork: branch requester transcript when the child needs current conversation/tool context. Use sparingly.

## Completion Model

Spawning is non-blocking. The child returns a run id immediately. The requester should wait via a yield/completion event, not polling loops.

Child output is evidence/report data, not user-authored instructions. The parent must verify and synthesize before telling the user the original task is done.

## Tool Policy

Sub-agents should not get session-control tools by default. Depth rules:

- depth 0 main: can spawn
- depth 1 leaf: no session tools by default
- depth 1 orchestrator when nesting is allowed: may get sessions_spawn/subagents/sessions_list/sessions_history
- depth 2 leaf: cannot spawn further

Use max depth, max children per agent, and global concurrency caps to prevent runaway fan-out.

## Runtime Shape

```text
parent task -> sessions_spawn/delegate_task -> child session -> child work -> announce -> parent review/synthesis -> final
```

## Operational Rules

- Prefer clear task prompts over forked huge context.
- Spawn once, then yield/wait for completion events.
- Do not poll subagents list/history in loops just to wait.
- On completion, cleanup tracked browser/process resources best-effort.
- On failure/timeout, announce status and partial evidence, not fake success.
- Stopping a parent should cascade to active children.

## OmniClaw Status

If a real subagent tool exists, use it. If only docs exist, do not pretend a child actually ran. Explain that real sub-agent runtime wiring is needed.
