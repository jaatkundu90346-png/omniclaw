# AGENT_LOOP.md - OmniClaw Main Agent Loop

summary: Agent loop lifecycle, streams, wait semantics, long-run behavior, and session safety.

read_when:
- You need an exact walkthrough of a real agent run.
- You are choosing tools for a user task.
- You are changing session queueing, transcript writes, streaming, timeouts, or long-running work.

## Definition

An agentic loop is the full real run:

```text
intake -> session routing -> context assembly -> model inference -> tool execution -> observation -> correction -> verification -> stream/persist -> final
```

The LLM is not the agent by itself. The agent is the manager that connects the LLM to tools and keeps state consistent.

## Entry Points

- Chat message / webchat.
- Gateway RPC or API call.
- Messaging channel event.
- Scheduled/cron/daemon task.
- Direct autonomous task request.

Each entry creates or resumes a session and should produce a run id.

## High-Level Flow

1. Accept message and resolve agent/session/profile.
2. Serialize the run on the session lane.
3. Load identity, memory, skills, tools, `TOOLS.md`, and this file.
4. Build system prompt/context.
5. Call provider/model for either final text or tool decisions.
6. Execute tool calls with real runtime tools.
7. Append observations back to the loop.
8. Retry or self-correct when observations fail.
9. Verify the task.
10. Persist transcript, tool traces, metadata, and checkpoints.
11. Emit final reply.

## Event Streams

The UI should be able to show real progress:

- `agent.thinking`: planning or deciding next step.
- `tool.started`: a tool is about to run.
- `tool.output`: output/stderr/stdout/data arrived.
- `tool.completed`: tool completed with structured result.
- `tool.failed`: tool failed or was blocked.
- `agent.reviewing`: verification or repair pass.
- `agent.done`: final reply and metadata.

No fake progress. If no search happened, do not say research happened.

## Queueing And Locks

- Only one active run should mutate a session transcript at a time.
- Tool observations and assistant replies must stay in order.
- Long-running work must not leave a session lane stuck forever.
- A wait timeout is not the same as cancellation.

## Timeouts

- Foreground complex work should be allowed up to about 1 hour.
- The run still needs a step budget and stop reason.
- 24-hour work belongs in background/autonomous/scheduler mode.
- Stalled model/tool calls should emit progress diagnostics and either retry, checkpoint, or abort cleanly.

## Tool Execution

Tool result format should be useful to the next model step:

- success/error/blocked status
- stdout/stderr for commands
- path/bytes/content preview for files
- URL/title/finalUrl/Markdown for fetch
- screenshot/path/evaluation result for browser
- provider/model/key status without secret values

If output is large, persist it and return a reference plus summary.

## Self-Correction

Failure does not end the loop automatically.

If a tool returns error, blocked, timeout, non-zero exit, failed verification, or missing file:

1. Read the exact observation.
2. Decide a targeted fix.
3. Run the fix.
4. Verify again.
5. Only then final, or explain the precise blocker.

## Final Reply

A final reply should include:

- what was done
- tools used
- proof/verification
- files/URLs/screenshots when relevant
- remaining issues/blockers
- stop reason for partial or long work

## 24-Hour Work Pattern

For long autonomous work:

1. Create a task folder.
2. Write `PLAN.md`.
3. Write/update `STATUS.md`.
4. Save `CHECKPOINT.md` after each phase.
5. Write `NEXT.md` before pausing.
6. Use background process/daemon/scheduler.
7. Resume from checkpoint instead of restarting.

The goal is not an endless open HTTP request. The goal is durable work until complete.
