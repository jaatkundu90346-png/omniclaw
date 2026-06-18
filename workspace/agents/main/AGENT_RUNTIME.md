# AGENT_RUNTIME.md - OmniClaw Main Agent Runtime

summary: Agent runtime, workspace contract, session bootstrap, steering, model refs, and runtime boundaries.

This file tells the main agent how OmniClaw runtime behavior should feel and what assumptions to keep during real tasks.

## Runtime Contract

OmniClaw is the local-first runtime/gateway. The active agent is hosted inside it.

```text
gateway intake -> session resolution -> workspace/context bootstrap -> provider/model call -> tool loop -> streamed events -> transcript persistence -> final reply
```

The LLM/provider is the reasoning brain. OmniClaw owns tools, sessions, workspace context, memory, approvals, event streams, channel delivery, background jobs, and persistence.

## Workspace Bootstrap

The runtime injects workspace context so the agent does not start fresh every turn.

Expected injected files:

- `AGENTS.md`: operating instructions and memory behavior.
- `SOUL.md`: persona, boundaries, tone.
- `TOOLS.md`: tool conventions and workflows; guidance only.
- `AGENT_LOOP.md`: lifecycle, events, queueing, wait semantics, self-correction.
- `AGENT_WORKSPACE.md`: workspace layout, privacy, backup, migration, sandbox notes.
- `AGENT_RUNTIME.md`: this runtime/session/bootstrap contract.
- `BOOTSTRAP.md`: first-run ritual, deleted after completion.
- `IDENTITY.md`: agent name/role/vibe.
- `USER.md`: user profile and preferred address.
- `PROFILE.md`: stable user/assistant facts.
- `HEARTBEAT.md`: heartbeat checklist.

Blank files can be skipped. Large files can be truncated with a marker. Missing files should not break the run.

## First-Run Ritual

`BOOTSTRAP.md` is only for a brand-new or unfinished agent ritual. While present, follow it one step at a time. When complete, delete it and do not recreate it later.

## Built-In Tools

Core tools are runtime-owned and permission-gated. `TOOLS.md` does not decide which tools exist; it teaches how to use them.

Tool availability comes from:

- runtime tool registry
- permissions/config
- skills
- plugins
- active agent/channel policy

## Skills

Skills are procedural memory. Prefer closer/more specific skills:

1. workspace skills
2. project/agent skills
3. personal skills
4. managed/local skills
5. bundled skills
6. extra configured folders

## Sessions

Sessions are runtime-owned and stable. Preserve message order and tool observations.

Rules:

- one active run per session lane
- transcript writes stay serialized
- final answer, tool observations, metadata, and stop reason are persisted
- long tasks checkpoint progress

## Steering While Streaming

If user input arrives mid-run:

- `steer`: deliver after current tool calls finish, before next model call.
- `followup`: queue for a later turn.
- `collect`: collect messages for later.
- `interrupt`: abort current run.

Steering must not skip current assistant tool calls.

## Streaming

Stream real progress:

- lifecycle start/end/error
- assistant deltas
- tool started/output/completed/failed
- agent thinking/reviewing/done

Coalesce tiny chunks for channels. Do not spam single-line fragments. Do not fake progress.

## Model References

Use `provider/model` refs. Parse on the first slash only because model ids may contain slashes.

Examples:

- `openrouter/moonshotai/kimi-k2`
- `nvidia/moonshotai/kimi-k2.6`
- `openai/gpt-4o-mini`

If provider is omitted, resolve aliases or unique configured model matches before falling back to default provider. If the default model is stale, choose a valid configured fallback and report it.

## Runtime Boundaries

Do not confuse provider text with completed work. A model can decide. OmniClaw executes.

Runtime owns:

- session management
- workspace discovery
- prompt context
- tool execution
- approvals
- event streams
- channel delivery
- transcript persistence
- checkpoints and background work

## Timeouts And Stop Reasons

Wait timeout is caller wait only. Runtime timeout bounds the run. Provider/model timeouts bound model calls. Cron/background timeout owns scheduled work.

Stop reasons:

- `final`
- `max_steps`
- `provider_failed`
- `tool_budget_exhausted`
- `blocked_for_approval`
- `timeout`
- `cancelled`

Always persist and explain stop reason for partial work.
